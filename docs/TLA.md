# Cloudy TLA+ models

`tla/Topology.tla` models the sim's discrete topology: springs, clouds, the `PairGate` records, and the order in which `stepOnce` (`src/sim/sim.ts`) breaks, relabels, arms and merges. `tla/Weather.tla` models the weather blend state machine (`src/params/weather.ts`). TLC checks both on every PR (`npm run tla`, CI job `tla`).

## Why model checking

The fast-check and sim tests sample geometries; they rarely build the three-cloud cases where the topology rules interact: a record inherited through a split, retargeted through a merge, then consulted by a later pass of `mergeTouching`. TLC enumerates every break set, every arming choice and every merge order for small clouds, so a rule change that breaks NoThrash in some corner fails on a trace a few steps long.

## What is checked

| PLAN invariant | TLA name | Kind |
| --- | --- | --- |
| BlobPartition | `BlobPartition` | invariant |
| SpringsInternal | `SpringsInternal` | invariant |
| CloudsConnected after relabel | `CloudsConnected` (spring components are exactly the clouds) | invariant, every state |
| Records name live clouds (as `checkInvariants` in `sim.test.ts`) | `RecordsLive` | invariant |
| NoThrash | `NoThrash`, with `GateCoversGhost` as the reason it holds | invariant against a ghost |
| Armed + touching merges | `ArmedTouchingMerge` | step property |
| Split conserves blob count and mass | `SplitConserves`, `MassConserved` | step property, invariant |
| Pieces can always re-merge | `ArmsWithinTau` | bounded liveness, as an invariant |

Weather: `TypeOK` (a transition has a duration and progress in [0, 1)), `TargetIsLatest` (a blend always heads to the latest request), `HeldSteady` ("step" fields never change mid-blend), `ProgressMonotone`, and `Settles` (once requests stop, the weather ends steady on the latest one; liveness under weak fairness of the per-step tick).

**NoThrash needs a ghost.** "Merge only if no record" is the guard in `mergeTouching`, so stating NoThrash on the records would restate the code. The spec keeps a ghost set of blob pairs that a split put in different pieces, each with its own age, armed exactly when the clouds now holding its blobs are beyond `d_release` or its age reaches tau. NoThrash says no such pair is ever in one cloud, directly or through a third cloud. That checks the inheritance in `recordSplit` and the retarget-and-clash rule in `recordMerge` independently of how they are written.

**Armed merge is a step property.** `armPairs` and `mergeTouching` run in the same step, so "merges on the next topology step" means "is merged when this step's `mergeTouching` returns". `ArmedTouchingMerge` says: after the merge loop, no two touching clouds are armed. The spec runs the loop pass by pass with its real bound (`MAX_BLOBS`, scaled to the blob count), so the property tests that the bound is enough, not a fixpoint written into the spec.

**Liveness is bounded.** The fixed-step loop always takes the next step, so "eventually arms" is "arms within so many steps", which is stronger and is a plain invariant: no record or ghost pair outlives the largest tau. The unbounded form (`~>` under weak fairness of both step actions) did not finish within a minute even on three blobs, where the safety check takes a second.

## How the spec maps to the code

| Spec | Code |
| --- | --- |
| `BreakArm`: break, `AfterBreak` (relabel when `dirty`), then `ArmWhere` | `updateSprings`, `relabel`, `refreshBoxes`, `armPairs` in `stepOnce` |
| `Merge`: `MergeLoop`, `PassFrom`, `MergeClouds`, then ages + 1 | `mergeTouching`, `mergeClouds`, `step++` |
| `DebugBreak` | `debugBreakSprings` (harness hook: relabel, no arming or merging) |
| `Components`, `Reach` | `labelComponents` |
| `Relabel`, `PiecesOf`, `SplitClouds` | `relabel`: group each old cloud's blobs by component root |
| `RecordSplit`, `RecordSplits` | `PairGate.recordSplit`, once per split cloud |
| `RecordMerge` (smaller age wins a clash) | `PairGate.recordMerge` and `put` (later `splitStep` wins) |
| `ArmWhere` | `PairGate.armWhere` with the `armPairs` predicate |
| `IsUnarmed` | `PairGate.isUnarmed` |
| `ByMinBlob` | iteration order of `clouds` after `rebuildClouds` |
| `gate[p]` (age) | `step - splitStep` |
| `TauMin..TauMax` | `tauSteps` from `params.tau` |
| `MaxPasses`, `MaxMergeSprings` | `MAX_BLOBS`, `MAX_MERGE_SPRINGS` |

Weather: `Advance` is `advanceWeather`, `StartTransition` is `startTransition`, `Target` is `targetWeather`, `Held` is the state `weatherLayer` holds "step" fields at.

## Abstractions and what they give up

- **A cloud is its set of blobs.** Cloud ids come from an unbounded counter (`nextCloudId`), and live clouds are disjoint, so the member set names a cloud as well as its id does. Which id survives a merge (the bigger cloud's) then cannot be seen; the merge order, which depends only on each cloud's smallest blob, is kept.
- **Any set of springs may break.** The strain rule, `flickCut` and `sparedLinks` only choose which candidates break, and the harness can break any set, so every break the code makes is one the spec makes. The spec cannot show that `sparedLinks` never sheds a wisp; with the real `MIN_PIECE_FLOOR`, no cloud this small would ever split.
- **Geometry is a free choice each step.** `touch` is a set of blob pairs within `d_touch`; `far` is a set of cloud pairs beyond `d_release`. GateOrdered (`d_touch < d_release`, kept by `clampParams`) is where the gap enters: a far pair has no touching blobs. Blobs may jump between classes from one step to the next (flicks and `wrapClouds` can do this too), so the spec explores more than physics allows, which is sound for safety. Two choices are pruned because they cannot change the result: `far` only for pairs the cooldown would not arm anyway, and touches only between clouds that are armed after `armPairs` (records only move during a merge, so an unarmed pair cannot become mergeable within the step).
- **Time is an age.** A record stores `step - splitStep`, not the step, so the state space is finite. Weather and the dev panel can change `tau` on any step, so each step picks tau from `TauMin..TauMax`. `PARAM_SPECS.tau.min` makes `tauSteps` at least 1; with 0, records would arm in the step they are made and NoThrash would be vacuous, so `ASSUME` rejects it.
- **Every touching cross pair gets a merge spring.** `mergeClouds` adds the `MAX_MERGE_SPRINGS` nearest; with four blobs a pair of clouds has at most four cross pairs, so the cap never binds (an `ASSUME` says so). Only "at least one spring" matters for connectivity.
- **Scenes start connected.** `Init` starts from any spring graph with the clouds as its components and an empty gate, as `loadScene` leaves it. If a shipped scene had a disconnected cloud, it would split at the first unrelated break, with no cause on screen. `sim.test.ts` checks this only for `m1`.
- **Size.** Three blobs (`Topology.cfg`) runs in a second and already shows both findings below. Four (`Topology.n4.cfg`) adds clouds of several blobs on both sides of a merge and two records of different ages clashing in `RecordMerge`: keeping the older split instead passes on three blobs and fails on four. Five blobs multiplies the break and touch choices past what fits in CI. `SYMMETRY` would be unsound: the merge order depends on blob indices.
- **Not modelled:** positions, forces, the cursor, creep, rest offsets, and mass changes from type multipliers (topology never reads mass; `MassConserved` uses distinct masses so a lost or doubled blob shows). Weather blends are counted in whole steps; the code adds `dt / duration` in floating point, so a blend can take one step more than the spec's.
- **Not modelled: strike ordering.** "Heard thunder minus flash peak = d" is one evaluation of `thunderStart` and `heardAt` per strike, with no interleaving for a model checker to explore; `strikes.test.ts` checks it for any latency.

## Where the code differs from PLAN

**"Armed + touching merges on the next step" does not hold pairwise, by design.** `PlanPairwiseMerge` states PLAN's sentence literally and is left out of the cfgs because TLC refutes it within one sim step on three blobs:

1. Cloud {2,3} splits into {2} and {3}; they are unarmed against each other. Cloud {1} touches both and is armed against both.
2. `mergeTouching` visits {1} first, merges it with {2} (the first armed, touching partner), and the {3} record retargets to {1,2}. {1} and {3} were armed and touching, and stay apart.

Merging both pairs would join {2} with {3} in the step they split, which is exactly what NoThrash forbids, so the code is right and PLAN's sentence is loose. `ArmedTouchingMerge` is the version the code keeps. Which pair merges depends on blob indices (the order `mergeTouching` visits clouds in), not on geometry: numbered the other way, {1} would have joined {3}.

**The gate is stricter than "split pairs".** Records follow clouds, not blobs: when a cloud merges and later splits along a different line, every piece inherits the merged cloud's records, including pieces whose blobs never split from the other side. TLC shows it within two sim steps: {1} splits from {3}; {1} merges with {2,4}; {1,2,4} splits back into {1} and {2,4}, and {2,4} is now unarmed against {3}. NoThrash holds; the price is that such a piece waits up to tau (or until it drifts beyond `d_release`) before it can merge with that cloud.

## Running it

- `npm run tla` runs TLC on every `tla/*.cfg`; a cfg checks the spec named before its first dot (`Topology.n4.cfg` checks `Topology.tla`). `TLA_ONLY=Topology.n4 npm run tla` runs one model.
- `scripts/tla.mjs` fetches the pinned `tla2tools.jar` into `.cache/tla` (gitignored) and checks its SHA-256; TLC's working files go there too, so `tla/` stays clean. GitHub lists no digest for the pinned release, so the hash in the script was recorded when the version was pinned. Java 11 or later is required.
- Exit code is non-zero on any violation, deadlock or TLC error; TLC prints the counterexample trace.
- After editing the spec, break it on purpose once: drop `~IsUnarmed(...)` from `PassFrom` and TLC must report `NoThrash` violated within one sim step. Dropping inheritance in `RecordSplit` must also fail `NoThrash`, setting `MaxPasses = 1` must fail `ArmedTouchingMerge`, and making `RecordMerge` keep the older split must fail `NoThrash` on `Topology.n4`. A property that never fails checks nothing.
- TLC re-evaluates a `LET` at every use, and operator arguments lazily. The actions bind expensive values once with `\E x \in {e}`; without that, the four-blob model is several times slower.

Measured when the models were added (16 threads): `Topology` 196 distinct states in about 1 s, `Topology.n4` 11,172 distinct states (751k generated) in about 4 s, `Weather` 280 distinct states in about 1 s.
