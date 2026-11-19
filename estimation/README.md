# Estimating the reply-tree model from data

The planner simulates an 18-parameter stochastic model of reply trees (`../src/sim.js`). This folder
holds the code that estimates those 18 parameters from post records, by maximum likelihood. The
parameter names are the same in both places, so an estimate can be put straight into the planner.

**Status.** The code is tested on synthetic records, where the true parameters are known, and has been
rehearsed on 2018–2019 US archives. It has not been run on 2024 Japanese data.

## Requirements and a first check

Python 3.10 or later with `numpy` and `scipy`. No network access is needed and nothing is installed
globally. Run everything from this folder.

```bash
python3 -m replytree2024.cli selftest
```

All 50 tests should pass (about a minute and a half).

## A worked example

```bash
python3 example/run_example.py
```

This invents about 70,000 post records from known parameters, runs the two commands a real analysis
runs (intake, then the fit) and prints the true values beside the estimates. It takes about 20 seconds.
The 13 parameters of the reply process come back close to the truth. The 5 parameters of the root are
compared as a distribution (the share of roots with at least k direct replies), because two mixture
components that overlap can be described by different parameter values.

## Estimating from your own records

**1. Records.** One record per post, in any order, as delimited text or JSON lines (plain or gzip):

| Field | Meaning |
|---|---|
| `post_id` | id of the post |
| `parent_id` | id of the post it replies to; empty for a root |
| `root_id` | id of the conversation (required on every record) |
| `time` | time of the post, as a number; `time_scale` converts it to seconds |
| `author` | author id; the tree files keep only a hash of it |

**2. Configuration.** A JSON file. Scientific settings have no defaults: a missing key stops the run
with a message that names it. `example/run_example.py` writes a complete `run.json` to copy from.

```json
{
  "workdir": "work",
  "input": {
    "format": "delimited", "paths": ["posts_part1.tsv.gz"], "delimiter": "\t", "header": true,
    "quotechar": null, "time_scale": 1.0,
    "fields": {"post_id": "id", "parent_id": "in_reply_to", "root_id": "conversation_id",
               "time": "created_at_epoch", "author": "author_id"}
  },
  "intake": {
    "cohort_start": 0, "cohort_end": 0, "observation_end": 0, "horizon_seconds": null,
    "missing_parent_rule": "", "reply_before_parent_rule": "", "cycle_rule": "",
    "n_buckets": 0, "max_bucket_records": 0, "max_malformed_records": 0
  },
  "blocks": {"training": [0, 0], "development": [0, 0], "final": [0, 0]},
  "g18_fit": {"fit_sample_fraction": 1.0, "starts": [{"label": "", "values": {}}]}
}
```

The zeros and empty strings are placeholders, not suggestions:

- `cohort_start`, `cohort_end`: roots posted in this window are used (seconds, same clock as `time`).
- `observation_end`: the last instant at which a reply could have been recorded. It is not the time of
  the last reply in the data.
- `horizon_seconds`: a tree is the root plus the replies posted within this time after the root, and
  only roots with that much follow-up before `observation_end` are used. Write `null` to use trees as
  collected.
- `missing_parent_rule`: what to do with a reply whose parent is not in the data: `quarantine_tree`,
  `drop_subtree` or `attach_to_root`.
- `reply_before_parent_rule`: `keep` or `quarantine_tree`.
- `cycle_rule`: `quarantine_tree` or `drop_component`.
- `n_buckets`, `max_bucket_records`: records are split into buckets of whole conversations; choose
  them so that one bucket fits comfortably in memory. A bucket above the limit stops the run.
- `max_malformed_records`: rows that cannot be parsed are counted; more than this stops the run.
- `blocks`: calendar blocks by root time. The model is fitted on `training`. The `final` block can be
  scored only with `--unlock-final`, and each such access is logged.
- `fit_sample_fraction`: the fraction of training trees used in the fit, chosen by a hash of the root id.
- `starts`: starting values for the 13 reply-process parameters (`c0 c1 s1 mu gam sig tau g0 f0 f1
  alpha0 b1 b2`). Give more than one; every start is kept in the output. The root's 5 parameters use
  8 built-in starts.

**3. Commands.**

| Step | Command | Output |
|---|---|---|
| Build trees | `python3 -m replytree2024.cli intake --config run.json` | `work/trees/`, `work/stats/`, `work/ledger.json` |
| Estimate | `python3 -m replytree2024.cli fit-g18 --config run.json` | `work/fits/g18_fit.json` |
| Score held-out trees | `python3 -m replytree2024.cli score-g18 --config run.json --block development` | mean log score per tree |
| Simulate from the estimate | `python3 -m replytree2024.cli simulate-g18 --config run.json --n 300000 --seed 1` | per-tree outcomes in `work/sim/` |
| Statistics for planning a collection | `declare-final-block`, then `design-stats` | `work/design_stats/` (aggregate counts only) |

Every step can be re-run. A work directory is bound to its input files and settings: a later run with
different inputs or settings in the same directory is refused, so use a new directory.

## Reading the results

`work/ledger.json` accounts for every record read: each is either kept or counted under one named
reason (duplicates, missing parents, roots outside the window, and so on). If any count is large,
resolve it before fitting.

`work/fits/g18_fit.json` holds the estimate under `parameters` and, for each part of the likelihood,
every start with its final value. Before an estimate is used, check that:

- `status` is `ok` (anything else is reported as unresolved, and scoring and simulation refuse it);
- more than one start reaches the best value (`starts_reaching_best`);
- `parameter_spread_among_best` is small relative to the estimates;
- `boundary_hits` is empty, or each listed parameter is reported as lying on a bound.

## Using an estimate in the planner

Copy the 18 values under `parameters` into a new entry of `CONFIG.models` in `../src/app.js`, add its
key to the "Start from" control in `GROUPS`, and run `python3 build.py` in the folder above.

## How the estimate is computed

The likelihood of a fully observed tree is a product of three parts, each fitted on its own:

| Part | Parameters | Method |
|---|---|---|
| Direct replies to the root | `w a1 t1 a2 t2` | exact likelihood of a two-component discretised lognormal mixture |
| Whether a reply is answered by exactly one reply | `c0 c1 s1 mu gam sig tau` | the per-conversation and per-chain effects are integrated out numerically, one integral per tree |
| Whether a chain ends in a split, and how many replies the split draws | `g0 f0 f1 alpha0 b1 b2` | exact likelihood |

Each part is maximised with L-BFGS-B from every start. After the fit, the numerical integration is
checked against a much finer grid at the estimate. Files: `replytree2024/g18.py` (likelihood),
`g18_fit.py` (fitting), `g18_sim.py` (generator, the Python original of `../src/sim.js`), `intake.py`
(records to trees), `design_stats.py` (planning statistics), `reference.py` and `tests/` (checks).

## What has been checked

- The likelihood against an independent fixed-grid reference on small trees: differences of at most 2e-11.
- The generator against the likelihood: small-tree frequencies from 600,000 simulated trees agree within
  simulation error.
- The analytic gradient against finite differences.
- Intake on synthetic records with injected duplicates, deleted replies and missing roots: the ledger
  equals the injected counts.

## Known limits

- The likelihood is for fully observed trees. A fit to trees cut at a fixed horizon describes those
  trees; it is not corrected for replies that arrive later.
- Trees are treated as independent.
- Every record must carry a conversation id. Rebuilding conversations from reply links alone is not
  implemented.
- One bucket must fit in memory, including the largest single conversation.
- Run time grows with the number of trees. In the rehearsal, 320,000 trees with 21 million posts took
  2 seconds per likelihood evaluation on one core. Measure it on a slice of your data first; if a full
  fit is too slow, set `fit_sample_fraction` below 1.

## What is not here

The planner's "Japan 2011", "US news" and "US midterms" settings came from an earlier fit by simulation
to published curves and to US archives. That code and its data are in the project's private research
repository, as are the notes that some comments in this code refer to.
