------------------------------ MODULE Weather ------------------------------
(***************************************************************************)
(* The weather blend state machine of src/params/weather.ts: steady or a   *)
(* transition with progress in [0, 1), retargeted by startTransition and   *)
(* advanced once per fixed step by advanceWeather (via stepDrive). Time is *)
(* counted in whole steps: progress is k / n. The blended values, and the  *)
(* fromWeights snapshot that keeps a retarget continuous, are left to the  *)
(* fast-check tests. docs/TLA.md has the mapping.                          *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    States,      \* WEATHER_STATES
    MaxSteps,    \* longest blend, in fixed steps
    MaxRequests  \* how many setWeather calls a behaviour makes (finite, so the blend can settle)

ASSUME MaxSteps \in Nat \ {0} /\ MaxRequests \in Nat

VARIABLES
    w,    \* Weather: [kind |-> "steady", state] or [kind |-> "transition", from, to, k, n], progress = k / n
    last, \* spec only: the state the latest request asked for
    left  \* spec only: requests still to come

vars == <<w, last, left>>

Steady(s) == [kind |-> "steady", state |-> s]
Blend(from, to, n) == [kind |-> "transition", from |-> from, to |-> to, k |-> 0, n |-> n]
\* targetWeather
Target(x) == IF x.kind = "steady" THEN x.state ELSE x.to
\* The state whose "step"-kind fields weatherLayer holds (a transition always has progress < 1 here).
Held(x) == IF x.kind = "steady" THEN x.state ELSE x.from

\* advanceWeather(w, FIXED_DT): steady stays; reaching progress 1 collapses to steady `to`.
Advance(x) ==
    IF x.kind = "steady" THEN x
    ELSE IF x.k + 1 >= x.n THEN Steady(x.to)
    ELSE [x EXCEPT !.k = @ + 1]

\* startTransition(w, to, seconds), with seconds as n steps (0 switches at once).
StartTransition(x, to, n) ==
    IF Target(x) = to THEN x
    ELSE IF n = 0 THEN Steady(to)
    ELSE IF x.kind = "steady" THEN Blend(x.state, to, n)
    ELSE Blend(x.from, to, n)

Init == \E s \in States : w = Steady(s) /\ last = s /\ left = MaxRequests

Tick == w' = Advance(w) /\ UNCHANGED <<last, left>>

Request == \E to \in States, n \in 0..MaxSteps :
    /\ left > 0
    /\ w' = StartTransition(w, to, n)
    /\ last' = to
    /\ left' = left - 1

Next == Tick \/ Request

\* The game steps the weather every fixed step.
Spec == Init /\ [][Next]_vars /\ WF_vars(Tick)

-----------------------------------------------------------------------------

\* The discriminated union: a transition has a duration > 0 and progress in [0, 1).
TypeOK ==
    \/ w.kind = "steady" /\ w.state \in States
    \/ /\ w.kind = "transition"
       /\ w.from \in States /\ w.to \in States
       /\ w.n \in 1..MaxSteps /\ w.k \in 0..(w.n - 1)

\* The blend is always heading to the latest request (a repeat request changes nothing).
TargetIsLatest == Target(w) = last

\* "step" fields never jump mid-blend: the held state changes only when the weather is or becomes steady.
HeldSteady == [][Held(w') # Held(w) => w.kind = "steady" \/ w'.kind = "steady"]_vars

\* Progress only grows within a blend; a retarget restarts it at 0.
ProgressMonotone ==
    [][w.kind = "transition" /\ w'.kind = "transition" /\ w'.to = w.to => w'.k >= w.k]_vars

\* Once requests stop, the weather settles on the latest one.
Settles == <>[](w = Steady(last))

=============================================================================
