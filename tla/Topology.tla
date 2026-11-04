------------------------------ MODULE Topology ------------------------------
(***************************************************************************)
(* The discrete topology of the middle cloud layer: springs, clouds, the    *)
(* PairGate records, and the order in which `stepOnce` (src/sim/sim.ts)     *)
(* runs them each fixed step. Positions, strain and gaps are abstracted     *)
(* into free choices, constrained only as the gate allows. docs/TLA.md has  *)
(* the mapping to the code and what the abstractions give up.              *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
    N,              \* blob count; blobs are the slots 1..N
    TauMin, TauMax, \* bounds of the cooldown in steps (tauSteps); weather may change it on any step
    MaxPasses,      \* mergeTouching's pass bound (MAX_BLOBS, which is >= the blob count)
    MaxMergeSprings \* MAX_MERGE_SPRINGS

Blobs == 1..N
\* Topology never reads mass, so any distinct positive masses do; distinct ones make a lost or doubled blob show.
Mass == [b \in Blobs |-> 2 ^ b]

ASSUME /\ N \in Nat \ {0}
       /\ TauMin \in Nat /\ TauMax \in Nat /\ 1 <= TauMin /\ TauMin <= TauMax
       /\ MaxPasses \in Nat /\ MaxPasses >= N
       \* mergeClouds adds the MAX_MERGE_SPRINGS nearest touching cross pairs; at this size the cap never binds,
       \* so the spec adds every touching cross pair (|A| * |B| <= N^2 / 4).
       /\ N * N <= 4 * MaxMergeSprings

VARIABLES
    springs, \* set of blob pairs {i, j}
    clouds,  \* the cloud labels: a set of blob sets. A cloud's identity is its members (see TLA.md)
    gate,    \* PairGate records: [{A, B} |-> age], age = step - splitStep. Absence of a record means armed
    ghost,   \* spec only: [{i, j} |-> age] for blob pairs a split separated that have not armed yet
    touch,   \* geometry of this step: cross-cloud blob pairs within d_touch. Empty between steps
    phase    \* "idle" between fixed steps; "merge" after armPairs, before mergeTouching

vars == <<springs, clouds, gate, ghost, touch, phase>>

-----------------------------------------------------------------------------
(* Helpers *)

Pairs(S) == {{i, j} : i, j \in S} \ {{i} : i \in S}
BlobPairs == Pairs(Blobs)
EmptyFn == [p \in {} |-> 0]
MinOf(S) == CHOOSE m \in S : \A x \in S : m <= x

RECURSIVE MassOf(_)
MassOf(C) == IF C = {} THEN 0 ELSE LET b == CHOOSE b \in C : TRUE IN Mass[b] + MassOf(C \ {b})
\* Summed cloud by cloud, so a blob in two clouds (or in none) changes the totals.
RECURSIVE SumMass(_)
SumMass(cs) == IF cs = {} THEN 0 ELSE LET C == CHOOSE C \in cs : TRUE IN MassOf(C) + SumMass(cs \ {C})
RECURSIVE SumSize(_)
SumSize(cs) == IF cs = {} THEN 0 ELSE LET C == CHOOSE C \in cs : TRUE IN Cardinality(C) + SumSize(cs \ {C})

\* The cloud holding blob b.
CloudOf(cs, b) == CHOOSE C \in cs : b \in C
\* Some blob of A is within d_touch of some blob of B.
Touching(t, A, B) == \E i \in A, j \in B : {i, j} \in t
IsUnarmed(g, A, B) == {A, B} \in DOMAIN g

\* Blobs reachable from S over springs s.
RECURSIVE Reach(_, _)
Reach(S, s) == LET S2 == S \cup {j \in Blobs : \E i \in S : {i, j} \in s} IN IF S2 = S THEN S ELSE Reach(S2, s)
\* labelComponents: connected components of the spring graph.
Components(s) == {Reach({b}, s) : b \in Blobs}

\* mergeTouching visits clouds in Map insertion order, which rebuildClouds makes the order of each cloud's smallest blob.
RECURSIVE ByMinBlob(_)
ByMinBlob(cs) == IF cs = {} THEN <<>>
                 ELSE LET C == CHOOSE C \in cs : \A D \in cs : MinOf(C) <= MinOf(D) IN <<C>> \o ByMinBlob(cs \ {C})

-----------------------------------------------------------------------------
(* PairGate (src/sim/topology.ts), on clouds named by their members *)

\* recordSplit(oldId, pieces, step): records of O move to every piece with their age; pieces are unarmed against
\* each other from now (age 0).
RecordSplit(g, O, pieces) ==
    LET inherited == {p \in DOMAIN g : O \in p}
        OtherOf(p) == CHOOSE X \in p : X # O
        moved == {{P, OtherOf(p)} : P \in pieces, p \in inherited}
        fresh == Pairs(pieces)
        dom == (DOMAIN g \ inherited) \cup moved \cup fresh
    IN [p \in dom |-> IF p \in fresh THEN 0
                      ELSE IF p \in DOMAIN g THEN g[p]
                      ELSE g[{O, CHOOSE X \in p : X \notin pieces}]]

\* recordMerge(drop, keep): records naming A or B now name A \cup B; the {A, B} self-pair vanishes; on a clash the
\* later split (the smaller age) wins, which is what `put` does.
RecordMerge(g, A, B) ==
    LET U == A \cup B
        retarget == {p \in DOMAIN g : (A \in p \/ B \in p) /\ p # {A, B}}
        OtherOf(p) == CHOOSE X \in p : X # A /\ X # B
        dom == (DOMAIN g \ {p \in DOMAIN g : A \in p \/ B \in p}) \cup {{U, OtherOf(p)} : p \in retarget}
    IN [p \in dom |-> IF p \in DOMAIN g THEN g[p]
                      ELSE MinOf({g[q] : q \in {r \in retarget : OtherOf(r) \in p}})]

\* armPairs: armWhere(step - splitStep >= tauSteps || gap > d_release).
ArmWhere(g, tau, far) == [p \in {q \in DOMAIN g : ~(g[q] >= tau \/ q \in far)} |-> g[p]]

Age(f) == [p \in DOMAIN f |-> f[p] + 1]

-----------------------------------------------------------------------------
(* relabel: each old cloud whose blobs fall into several components splits into those pieces *)

\* K is labelComponents of the springs left.
PiecesOf(O, K) == {O \cap k : k \in K} \ {{}}
Relabel(cs, K) == UNION {PiecesOf(O, K) : O \in cs}
SplitClouds(cs, K) == {O \in cs : Cardinality(PiecesOf(O, K)) > 1}

\* relabel calls recordSplit once per split cloud; the order does not matter.
RECURSIVE RecordSplits(_, _, _)
RecordSplits(g, todo, K) ==
    IF todo = {} THEN g
    ELSE LET O == CHOOSE O \in todo : TRUE IN RecordSplits(RecordSplit(g, O, PiecesOf(O, K)), todo \ {O}, K)

\* The ghost marks every blob pair the split put in different pieces.
GhostSplits(h, cs, K) ==
    LET fresh == {p \in BlobPairs : (\E O \in cs : p \subseteq O) /\ ~\E k \in K : p \subseteq k}
    IN [p \in DOMAIN h \cup fresh |-> IF p \in fresh THEN 0 ELSE h[p]]

\* The ghost arms a pair exactly when the clouds now holding its blobs are beyond d_release, or by cooldown.
\* cof maps a blob pair to the clouds holding its blobs.
GhostArm(h, cof, tau, far) == [p \in {q \in DOMAIN h : ~(h[q] >= tau \/ cof[q] \in far)} |-> h[p]]

\* updateSprings breaks springs, leaving `s` with components K; relabel runs only when it broke something (`dirty`).
AfterBreak(s, K) ==
    IF s = springs THEN [springs |-> s, clouds |-> clouds, gate |-> gate, ghost |-> ghost]
    ELSE [springs |-> s, clouds |-> Relabel(clouds, K),
          gate |-> RecordSplits(gate, SplitClouds(clouds, K), K), ghost |-> GhostSplits(ghost, clouds, K)]

-----------------------------------------------------------------------------
(* mergeTouching, pass by pass as the code runs it *)

\* mergeClouds(a, b): springs between the touching cross pairs, one cloud, records retargeted.
MergeClouds(st, A, B, t) ==
    [st EXCEPT !.springs = @ \cup ({{x, y} : x \in A, y \in B} \cap t),
               !.clouds = (@ \ {A, B}) \cup {A \cup B},
               !.gate = RecordMerge(@, A, B),
               !.used = @ \cup {A, B},
               !.merged = TRUE]

\* One pass: for each cloud not yet used this pass, merge it with the first later cloud that is unused, armed and touching.
RECURSIVE PassFrom(_, _, _, _)
PassFrom(st, ids, x, t) ==
    IF x > Len(ids) THEN st
    ELSE LET a == ids[x]
             ys == {y \in (x + 1)..Len(ids) : ids[y] \notin st.used /\ ~IsUnarmed(st.gate, a, ids[y]) /\ Touching(t, a, ids[y])}
         IN IF a \in st.used \/ ys = {} THEN PassFrom(st, ids, x + 1, t)
            ELSE PassFrom(MergeClouds(st, a, ids[MinOf(ys)], t), ids, x + 1, t)

\* Passes until one merges nothing, at most MaxPasses (gate records are not re-armed between passes).
RECURSIVE MergeLoop(_, _, _)
MergeLoop(st, pass, t) ==
    IF pass >= MaxPasses THEN st
    ELSE LET st2 == PassFrom([st EXCEPT !.used = {}, !.merged = FALSE], ByMinBlob(st.clouds), 1, t)
         IN IF st2.merged THEN MergeLoop(st2, pass + 1, t) ELSE st2

-----------------------------------------------------------------------------
(* The spec *)

\* loadScene: a scene's clouds start connected and the gate starts empty (TLA.md: the scene assumption).
Init == \E s \in SUBSET BlobPairs :
            /\ springs = s
            /\ clouds = Components(s)
            /\ gate = EmptyFn
            /\ ghost = EmptyFn
            /\ touch = {}
            /\ phase = "idle"

\* stepOnce up to armPairs: the world step moves blobs (free), updateSprings breaks any subset of springs (the strain
\* rule and sparedLinks only pick which), relabel, then armPairs with this step's tau and geometry.
\*  - `far`: cloud pairs beyond d_release. Only pairs with a record or a ghost pair that the cooldown would not arm are
\*    chosen; any other choice gives the same step.
\*  - `t`: blob pairs within d_touch. GateOrdered (d_touch < d_release) means a far pair has no touching blobs. Touches
\*    between clouds that stay unarmed are left out: no merge can use them (records only move, see RecordMerge).
BreakArm ==
    /\ phase = "idle"
    \* `\E x \in {e}` binds the value of e once (TLC would re-evaluate a LET at every use).
    /\ \E broken \in SUBSET springs, tau \in TauMin..TauMax :
       \E K \in {Components(springs \ broken)} :
       \E b \in {AfterBreak(springs \ broken, K)} :
       \E cof \in {[q \in BlobPairs |-> {CloudOf(b.clouds, i) : i \in q}]} :
        LET cands == {p \in DOMAIN b.gate : b.gate[p] < tau} \cup {cof[q] : q \in {r \in DOMAIN b.ghost : b.ghost[r] < tau}}
        IN \E far \in SUBSET {p \in cands : Cardinality(p) = 2} :
           \E g \in {ArmWhere(b.gate, tau, far)} :
            /\ springs' = b.springs
            /\ clouds' = b.clouds
            /\ gate' = g
            /\ ghost' = GhostArm(b.ghost, cof, tau, far)
            /\ touch' \in SUBSET {p \in BlobPairs : Cardinality(cof[p]) = 2 /\ cof[p] \notin far \cup DOMAIN g}
            /\ phase' = "merge"

\* mergeTouching, then step++ (wrapClouds moves positions only).
Merge ==
    /\ phase = "merge"
    /\ \E st \in {MergeLoop([springs |-> springs, clouds |-> clouds, gate |-> gate, used |-> {}, merged |-> FALSE], 0, touch)} :
          /\ springs' = st.springs
          /\ clouds' = st.clouds
          /\ gate' = Age(st.gate)
          /\ ghost' = Age(ghost)
          /\ touch' = {}
          /\ phase' = "idle"

\* debugBreakSprings (harness hook): break springs between steps, relabel at once; no arming, no merging.
DebugBreak ==
    /\ phase = "idle"
    /\ \E broken \in SUBSET springs \ {{}} :
       \E K \in {Components(springs \ broken)} :
       \E b \in {AfterBreak(springs \ broken, K)} :
           /\ springs' = b.springs
           /\ clouds' = b.clouds
           /\ gate' = b.gate
           /\ ghost' = b.ghost
           /\ UNCHANGED <<touch, phase>>

Next == BreakArm \/ Merge \/ DebugBreak

\* Safety only. The fixed-step loop always takes the next step, so "eventually" is "within so many steps", and the
\* one liveness property is checked in that bounded form (ArmsWithinTau).
Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants (docs/PLAN.md, "Invariants to keep") *)

TypeOK ==
    /\ springs \subseteq BlobPairs
    /\ clouds \subseteq SUBSET Blobs
    /\ DOMAIN gate \subseteq SUBSET clouds /\ \A p \in DOMAIN gate : gate[p] \in Nat
    /\ DOMAIN ghost \subseteq BlobPairs /\ \A p \in DOMAIN ghost : ghost[p] \in Nat
    /\ touch \subseteq BlobPairs
    /\ phase \in {"idle", "merge"}

\* Every blob is in exactly one non-empty cloud.
BlobPartition ==
    /\ UNION clouds = Blobs
    /\ {} \notin clouds
    /\ \A A, B \in clouds : A # B => A \cap B = {}

\* Every spring joins blobs of one cloud.
SpringsInternal == \A p \in springs : \E C \in clouds : p \subseteq C

\* Each cloud is connected: the spring graph's components are exactly the clouds.
CloudsConnected == clouds = Components(springs)

\* Every record names two distinct live clouds (sim.test.ts checks the same).
RecordsLive == \A p \in DOMAIN gate : Cardinality(p) = 2 /\ p \subseteq clouds

\* NoThrash: a blob pair a split separated is never in one cloud again (directly, or through a third cloud) until it
\* arms, by its clouds being beyond d_release or by cooldown.
NoThrash == \A p \in DOMAIN ghost : ~\E C \in clouds : p \subseteq C

\* Why NoThrash holds: the gate is at least as strict as the ghost (a record between the clouds, armed no sooner).
GateCoversGhost ==
    \A p \in DOMAIN ghost :
        LET q == {CloudOf(clouds, b) : b \in p} IN q \in DOMAIN gate /\ gate[q] <= ghost[p]

\* Topology never creates or destroys blobs or mass.
MassConserved == SumMass(clouds) = MassOf(Blobs) /\ SumSize(clouds) = N

-----------------------------------------------------------------------------
(* Step properties *)

\* A split conserves blob count and mass: every cloud that splits is the disjoint union of its pieces.
SplitConserves ==
    [][\A O \in clouds :
          LET pieces == {P \in clouds' : P \subseteq O}
          IN pieces # {} => /\ UNION pieces = O
                            /\ SumSize(pieces) = Cardinality(O)
                            /\ SumMass(pieces) = MassOf(O)]_vars

\* Armed + touching merges on the same topology step: when mergeTouching returns, no two clouds that touch are armed.
\* (Pieces that just split are touching and unarmed, so "touching" alone is not enough.)
ArmedTouchingMerge ==
    [][phase = "merge" /\ phase' = "idle" =>
          \A A, B \in clouds' : A # B /\ Touching(touch, A, B) => IsUnarmed(gate', A, B)]_vars

\* The pairwise reading of PLAN: two clouds armed and touching after armPairs share a cloud after the step.
\* NOT a property of the code, and not checked: when A touches B and C, armed against both, and B and C are unarmed,
\* whichever merges first inherits the other's record and blocks the second merge (NoThrash wins). TLA.md has the trace.
PlanPairwiseMerge ==
    [][phase = "merge" /\ phase' = "idle" =>
          \A A, B \in clouds : A # B /\ Touching(touch, A, B) /\ ~IsUnarmed(gate, A, B) =>
              \E C \in clouds' : A \cup B \subseteq C]_vars

\* Bounded liveness: whatever the geometry, a split pair (and its record) arms within TauMax steps of the split, so
\* split pieces can always re-merge. An age counts steps since the split; one past the bound would mean it never armed.
ArmsWithinTau ==
    /\ \A p \in DOMAIN gate : gate[p] <= TauMax
    /\ \A p \in DOMAIN ghost : ghost[p] <= TauMax

=============================================================================
