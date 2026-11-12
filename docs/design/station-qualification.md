# Station qualification and rollout

Run each opt-in against the single-author baseline on the same fixture and
model. The live harness starts a fresh, disposable Git worktree for each arm,
uses fixed artifacts and approvals to reach the measured station, and stops the
measured station at its real approval gate. It alternates arm order by case and
iteration. The runner applies fixture candidates and runs configured checks in
those worktrees. The harness only sends the synthetic fixture to the provider.
The benchmark has no publication step.

```powershell
pnpm benchmark:qualify
pnpm benchmark:qualify --offline
pnpm benchmark:qualify --live --config C:/work/pinned-role.json --iterations 1 --max-calls 28
pnpm benchmark:qualify --live --config C:/work/pinned-role.json --iterations 10 --max-calls 280 --reasoning-effort low --unit-runtime-ready --codex-quota
pnpm benchmark:review C:/work/run/report.json --config C:/work/pinned-review-role.json
```

The role file uses the regular author configuration shape, with an explicit
provider and model. For example, a signed-in Windows Codex CLI can use
`{"provider":"codex","model":"gpt-6.1-sol","windowsSandbox":"unelevated"}`.
`--timeout-ms` applies equally to both arms. `--max-calls` limits runner calls to
the provider adapter. An adapter can make its own bounded corrective attempt,
which is also recorded. The full matrix plans 28 calls for one repetition.
The default measures one pair at a time. `--parallel-pairs 8` runs up to eight
independent pairs in separate fixture repositories on the same host. Each pair
still measures one arm at a time and alternates its starting arm across
repetitions. The report records the limit so shared-host latency can be read
separately from serial pilot latency. Station-level worker limits apply within
each worktree.
For Codex, set `--reasoning-effort` to the intended deployment value to pin it
for both arms. A report with an unset effort used the CLI's inherited setting.
On Windows the Codex child uses the standalone sandbox backend when launched
from Kitchen, including when the parent is the desktop app. The child retains
`--sandbox read-only` and the role's `windowsSandbox` setting. Git and file
inspection run from the linked worktree. The workstation's desktop process
continues to use its registered sandbox.
If repository tools cannot run, add `--embedded-source` to send the same frozen
fixture text to both arms and disable model tools. This measures live authoring
and worker coordination from supplied context. The report holds those runs
out of rollout eligibility until a tools-enabled matrix is available.

| Cases | Variable changed in the opt-in arm | Fixture quality evidence |
| --- | --- | --- |
| `discovery` | Plan discovery pair | Valid plan and exact approved candidate scope |
| `spec-specialists` | Spec specialist pair | Observable acceptance criteria and coverage of the two-package contract |
| `test-plan-specialists` | Test-plan specialist pair | Exact unit scope and required per-package RED mappings |
| `verify-specialists` | Verify specialist pair | Fresh GREEN checks and identification of a seeded SMS null-input defect |
| `unit-proposals` | Two disjoint test proposal groups | Assertion RED at the pinned base and test data covering null, whitespace, and preservation |
| `implementation-proposals` | Two disjoint implementation proposal groups | Integrated GREEN and separate behavior probes |
| `unit-checks`, `implementation-checks`, `verify-checks` | `parallelSafe` on two independent profiles | Same station gates and quality checks as their respective stages |

The fixture uses declarative test case tables and a bounded VM for the generated
normalizers. The seeded verify fixture has passing visible checks but an SMS
`normalize(null)` defect. The reported defect signal is a text heuristic. Check
the actual finding and proposed correction before using it as quality evidence.
For rollout, have a reviewer compare anonymized candidate artifacts and check
reports against the same requirements. Record missed defects, unsupported
findings, and unnecessary operator questions per arm. `benchmark:review`
randomizes A/B and pair order, includes source and hash-checked assertion
evidence where applicable, and saves the blind judgments before mapping them
to arms. Use `--prepare-only` to produce a packet for a human reviewer. Share
`packet.json` alone until judgments are recorded, then use `key.json` to map
each result. A live reviewer runs in a fresh, tool-free session against that
same evidence. Record live model judgments separately from human sign-off.
Include a small task,
an independent multi-package task, and a task with shared interfaces or a
material question. Keep shared-interface work serial when ownership cannot be
split safely. This harness's built-in matrix covers one independent fixture.

Reports are under `.kitchen/benchmarks/live-stations-*`. Each arm records its
input fingerprint, tests-first commit where applicable, station status, check
evidence, calls, attempts, and fixture quality scores. The latency comparison
uses pairs with the same inputs and passing quality scores on both sides. The
raw samples and arm totals retain failures, unanswered questions, timeouts, and
retries. Active time includes source checks, joining, and required check
execution at the measured station. It excludes fixture setup and human wait.
Provider work sums attempt durations. Provider elapsed time accounts for
overlapping attempts. Cache behavior and model load can vary between calls.

If the unit author asks for a runtime handoff on this dependency-free fixture,
`--unit-runtime-ready` repeats the unit cases with the same fixed operator
answer supplied in both arms. Keep the original question-only results and
report the answered experiment separately.

Token totals include cached input where the adapter reports it. Token use is an
inference work measure. Dollar totals use provider-reported amounts and remain
unknown when any attempt lacks them. Use a dated billing or quota comparison
for your deployment if the CLI cannot report the charge. Do not enter an API
key in the role file.

For signed-in Codex, `--codex-quota` records the account's reported limit
buckets before the matrix, after the first and every fifth repetition, and
at completion. Each window includes the used percentage and reset time. Compare
readings with the same bucket and reset timestamp. Account-level usage includes
other sessions and coarse percentage rounding, so the snapshots establish
headroom and total account movement. Use per-arm token totals to compare
inference work. Dollar cost and attributable quota by arm require separate
provider evidence or an explicit decision from the cost or quota owner.

Start with one paired live canary. Keep each opt-in at `hold` until it passes
all of the following on the intended model, platform, and workload:

- At least ten matched pairs per mode with complete evidence. Treat p95 as
  preliminary below twenty pairs and investigate tail regressions before
  expanding the pilot.
- Both arms meet the runner's approval prerequisites. The opt-in preserves
  required coverage and seeded blocker detection, with no increase in
  contract failures, retries, or unanswered questions. Blind review agrees
  that the output is at least as usable as the baseline.
- Median active time is at least 15% lower. Aggregate token work and reported
  cost rise by at most 10%. Missing usage or cost requires separate evidence
  and an explicit decision from the quota or cost owner before rollout.

The report's `eligible-for-blind-review` status is a machine gate for the
built-in fixture. The reviewer and cost owner make the rollout decision. Enable
only the qualified mode and station on a small set of eligible features first.
Keep hosted worker concurrency at two per station and local generation serial.

Roll back immediately on a missed blocker, a failed scope or source guard, or
lost RED/GREEN evidence. Roll back a pilot that exceeds its agreed cost or
failure budget, or loses its latency gain in follow-up matched runs. Retain the
reports and failed evidence. Restore the corresponding baseline setting:

- Set `discovery.enabled` to `false` for plan discovery.
- Set `stations.<station>.specialistsEnabled` to `false` for specialist analysis.
- Set `stations.<station>.proposalGroups.<feature>` to `false` for file proposals.
- Set `parallelSafe` to `false` on the affected check profiles.

Run `kitchen status <feature>` to find the earliest stale station. Rerun and
review from that station in order. If a failed pilot left candidate edits,
inspect its diff before rerunning so the baseline starts from the intended
candidate. Use the normal tests-first revision procedure if approved tests
need changing.

## Live canary on 2026-11-12

The complete comparison used `gpt-6.1-sol` with low reasoning and embedded
fixture source. Earlier tools-enabled attempts stopped after Windows failed to
launch repository commands from the linked worktree. A supplied-context trial
with inherited `xhigh` reasoning timed out. Those attempts have separate local
reports. This canary measures live responses to supplied context and holds all
modes out of rollout qualification.

The initial low-effort matrix recorded four unit arms that asked for a runtime
handoff and one verify arm that hit a Windows metrics-file lock before authoring.
The rerun used fresh fixtures and repeated both arms of the affected cases. Its
unit arms received identical feedback that the pinned runtime already worked.
All nine selected pairs passed the fixture scores. Both verify specialist arms
identified the seeded SMS null-input defect, and both proposal pairs established
their expected RED or GREEN evidence.

| Case | Single author | Opt-in | Single-author tokens | Opt-in tokens |
| --- | ---: | ---: | ---: | ---: |
| Plan discovery | 43.04 s | 65.12 s | 17,765 | 50,163 |
| Spec specialists | 35.41 s | 57.05 s | 16,869 | 47,539 |
| Test-plan specialists | 48.99 s | 69.74 s | 18,950 | 51,477 |
| Verify specialists | 26.20 s | 38.43 s | 19,491 | 51,326 |
| Unit file proposals | 23.28 s | 11.20 s | 18,039 | 34,919 |
| Implementation file proposals | 19.62 s | 9.23 s | 18,518 | 36,040 |
| Unit check scheduling | 20.15 s | 23.45 s | 17,893 | 18,048 |
| Implementation check scheduling | 19.92 s | 20.18 s | 18,500 | 18,530 |
| Verify check scheduling | 22.00 s | 22.78 s | 19,314 | 19,346 |

The two file proposal cases reduced active time by 52–53% while increasing
reported token work by 94–95%. Discovery and specialists increased both elapsed
time and token work on this fixture. Check scheduling shortened the recorded
check phases from 487 to 424 ms, 166 to 97 ms, and 154 to 92 ms in unit-tests,
implementation, and verify respectively. The unit phase includes detached
baseline setup. None of the three check-scheduling pairs reduced overall active
time on this short-check fixture.

The nine selected pairs used 165,339 baseline tokens and 327,388 opt-in tokens.
The two low-effort reports retain 34 calls in total, including the question-only
arms and the unmatched verify baseline. Codex supplied token counts and no
dollar charges. Each row represents one pair. The decision is **hold** pending
tools-enabled repetitions, blind review, and billing or quota evidence.

Local evidence:

- `.kitchen/benchmarks/live-stations-2ebdeb1e-98a8-40cd-9f00-f748f9454e94/report.json`
  contains the first low-effort matrix and its incomplete pairs.
- `.kitchen/benchmarks/live-stations-93eb1cef-0d2f-43fd-84e8-a1aa57c96988/report.json`
  contains the three matched reruns.

## Tools-enabled Windows canary on 2026-11-12

The nested CLI inherited the desktop's registered Core launch marker, even
though a CLI subprocess has no registered package identity. Kitchen now omits
that marker from the Windows Codex child environment. Both configured Windows
sandbox modes opened the linked worktree. The `unelevated` sandbox ran the
previously failing multi-file PowerShell read, Git tree listing, and Git diff.
A write attempt from the same read-only sandbox was denied.

The live canary recorded 41 successful commands and no package-identity
failures. Plan discovery and verify specialists passed fixture checks in both
arms. The single-author unit-tests candidate tried to replace an approved
document. The workflow rejected it before RED, and the opt-in arm established
counted RED in both packages. The blind model reviewer confirmed the unit
evidence, found the seeded SMS defect in both verification responses, and
flagged differences in the support for historical claims. The two reviewed
reports preserve the original packet and a second packet with the pinned
revisions and assertion records added to both arms.

- `.kitchen/benchmarks/windows-tools-canary/report.json`
- `.kitchen/benchmarks/windows-tools-canary/blind-review-with-assertions/results.json`

## Tools-enabled paired qualification

The serial pilot completed one full nine-case repetition before the benchmark
switched to a separate shared-host matrix. The serial pilot and its blind
review stay in `.kitchen/benchmarks/windows-tools-qualification/`. The primary
matrix uses ten fresh pairs per case with up to eight pairs active on the host.
Both arms use Codex CLI `0.167.0-alpha.4.1`, `gpt-6.1-sol` at low reasoning,
the `unelevated` read-only sandbox, and the same unit runtime handoff. Review
runs use fresh tool-free Codex sessions at medium reasoning.

The shared-host run exposed transient Windows locks on atomic replacements of
`state.json` and `metrics.json` during fixture setup. Kitchen now retries those
replacements and benchmark report checkpoints for up to 620 ms on Windows,
retaining the previous file until the rename succeeds. A live filesystem probe
observed `EPERM` on the first replacement, read the previous file during the
lock, and confirmed that the retry committed the replacement after release.
The primary matrix preserves the failed samples it measured before the retry
change. Supplemental pairs use the retry and remain separate.

The primary matrix finished 90 scheduled pairs and 276 live calls. Both arms
passed the fixture quality checks in 82 pairs. The CLI recorded 820 successful
shell commands and zero package-identity failures. The table uses median
station time for quality-passing pairs and token totals across all attempts.

| Case | Passing pairs | Baseline | Opt-in | Active time change | Token change |
| --- | ---: | ---: | ---: | ---: | ---: |
| Plan discovery | 10/10 | 50.92 s | 80.07 s | +57.3% | +193.5% |
| Spec specialists | 9/10 | 34.19 s | 61.11 s | +78.7% | +262.2% |
| Test-plan specialists | 10/10 | 50.36 s | 83.72 s | +66.2% | +278.4% |
| Verify specialists | 9/10 | 40.07 s | 73.61 s | +83.7% | +245.8% |
| Unit file proposals | 9/10 | 25.79 s | 12.46 s | −51.7% | +2.3% |
| Implementation file proposals | 10/10 | 20.04 s | 10.85 s | −45.8% | −0.6% |
| Unit check scheduling | 6/10 | 26.91 s | 25.67 s | −4.6% | +6.5% |
| Implementation check scheduling | 10/10 | 21.22 s | 19.06 s | −10.2% | −25.8% |
| Verify check scheduling | 9/10 | 44.39 s | 43.95 s | −1.0% | −25.0% |

Check scheduling reduced median check-phase time from 535 to 463 ms in
unit-tests, 157 to 98 ms in implementation, and 157 to 89 ms in verify. All
three whole-station gains fell short of the 15% gate. The unit phase includes
the detached baseline setup.

The account's reported weekly Codex quota went from 3% used at 16:12 UTC to
5% used at 16:38 UTC on November 12. Both readings have the same reset timestamp
and neither reported a spend-control limit. Across the matrix the single-author
arms reported 4,268,414 tokens and the opt-in arms 8,815,635. The account
readings are aggregate. Dollar cost and attributable quota by arm remain
unverified.

- `.kitchen/benchmarks/windows-tools-shared-host/report.json` contains the
  primary matrix, failed samples, and four quota snapshots.
- `.kitchen/benchmarks/windows-tools-lock-reruns/report.json` contains both
  arms of the three supplemental pairs after the Windows retry change.

All six supplemental arms reached the live provider with no file-lock failure.
Both verify pairs passed their fixture checks. The unit proposal baseline again
returned a document replacement, which the approval guard rejected before RED.
The opt-in arm recorded RED for both packages. In the primary matrix, other
quality failures included the same attempted document replacement in unit
check scheduling, a spec candidate that mixed questions with a document, and
a verify specialist run that stopped for input.

### Blind review and rollout decision

A fresh Codex session reviewed anonymized artifacts and assertion records for
all 87 primary pairs with two reviewable station records. Three setup failures
left one arm without an artifact. The reviewer rated 52 opt-in outputs at
least as usable as their baselines and marked 14 opt-in and 15 baseline outputs
with material defects. It rated two of the three supplemental opt-in outputs
at least as usable as their baselines.

Implementation file proposals passed all ten fixture pairs and the reviewer
preferred all ten opt-in outputs. The reviewer usually cited their adherence
to the output contract for runner-owned metadata. The paired code behavior
and GREEN records were generally equivalent. Unit file proposals were rated
at least as usable in two of nine reviewable primary pairs. Reviewers favored
broader whitespace and preservation coverage in several single-author outputs.

**Hold rollout.** Implementation file proposals met the measured latency,
token, fixture quality, and blind model review thresholds on this workload.
They still require human sign-off and an attributable cost comparison or a
recorded quota-owner decision. The other cases missed at least one measured
gate. Tail latency remains preliminary at ten repetitions. Apply the workload
coverage and rollback criteria above before enabling any station in a pilot.

- `.kitchen/benchmarks/windows-tools-shared-host/blind-review-1-3/results.json`
- `.kitchen/benchmarks/windows-tools-shared-host/blind-review-4-6/results.json`
- `.kitchen/benchmarks/windows-tools-shared-host/blind-review-7-10/results.json`
- `.kitchen/benchmarks/windows-tools-lock-reruns/blind-review/results.json`
- `.kitchen/benchmarks/windows-tools-shared-host/human-review/packet.json`
  contains the consolidated blind packet for human review.
- `.kitchen/benchmarks/windows-tools-shared-host/quota-after-review.json`
  records 5% used at 16:48 UTC after the model reviews and targeted reruns,
  in the same weekly quota window.

## Implementation file proposals sign-off

**Rollout hold.** The ten implementation proposal pairs all passed the fixture
checks. Median station time fell from 20.04 s to 10.85 s, a 45.8% reduction.
The evidence covers the tools-enabled Windows shared-host run on GPT-6.1 Sol
at low reasoning, with up to eight independent pairs active on the host. The
measured station stopped at human approval in all twenty arms.

### Per-arm cost evidence

The thirty completed Codex usage records reconcile to the raw CLI events.
The estimate uses the GPT-6.1 Sol Standard credit rates listed on
November 12, 2026. The rates per million tokens are
50 credits for uncached input, 2.5 for cached input, and 250 for output.
Cached input is part of the CLI input total. Reasoning tokens are already
included in output. [OpenAI Codex token rates](https://learn.chatgpt.com/docs/pricing#token-rates)

| Across ten arms of each kind | Single author | Parallel proposals |
| --- | ---: | ---: |
| Completed calls | 10 | 20 |
| Uncached input tokens | 119,974 | 148,452 |
| Cached input tokens | 219,904 | 192,000 |
| Output tokens | 7,543 | 4,887 |
| Total tokens | 347,421 | 345,339 |
| Standard credit equivalents | 8.43421 | 9.12435 |

The opt-in used 0.6% fewer total tokens and cost **8.18% more** at the Standard
credit rates. It had more uncached input, and its estimated cost was higher in
seven of ten pairs. The estimate is 1.82 percentage points below the +10%
ceiling. The signed-in benchmark emitted no billed amount or per-call quota
delta. The account reported 5% of the same weekly window used at 16:53 UTC.
The account reading covers all usage in that window. The credit-rate estimate
and the included subscription quota use different measures. [Codex quota fields](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)

**Cost gate pending.** The cost or quota owner records either attributable
metered evidence within the +10% ceiling or explicit acceptance of the dated
credit-rate estimate for the intended deployment. The audit contains both
arms' token buckets, the calculation per pair, and hashes and timestamps for
all thirty raw call logs.

### Blind quality review

The blind model preferred all ten parallel proposals and found zero material
defects in them. In the single-author arm it marked nine minor findings and
one material finding. All ten concerned redundant author declarations of
allowed paths, test files, and check definitions. The runner used the approved
plan and test plan. Both arms stayed within the two production
files, retained the approved test hashes, and recorded three passing GREEN
assertions per package. All twenty candidates passed the eight independent
behavior probes. The two proposed files matched byte for byte in one pair.

**Human quality gate pending.** Give the reviewer the packet and decision form
from `reviewer/`. They contain fresh A/B labels, the proposed source, approved
test tables, and hash-verified assertion records. The reviewer records judgments
and supporting evidence before seeing the mapping. After unblinding, sign off
only if each parallel proposal is at least as usable as its baseline and has
no material defect. Record the reviewer, date, and any scope limitations.
Keep the rollout on hold while either decision is pending.

Evidence is under `.kitchen/benchmarks/implementation-proposals-signoff/`.

- `reviewer/packet.json` and `reviewer/decision-form.json` are the blind review materials.
- `arm-cost-evidence.json` and `account-quota-snapshot.json` support the cost decision.
- `blind-model-review.json` preserves the ten model judgments. The owner uses
  `review-key.json` to unblind the new packet after the human submits the form.
