"""Command line for the Claude-owned steps: intake, G18 fit, scores, simulation.

    python -m replytree2024.cli intake        --config run.json
    python -m replytree2024.cli fit-g18       --config run.json
    python -m replytree2024.cli score-g18     --config run.json --block development
    python -m replytree2024.cli simulate-g18  --config run.json --n 300000 --seed 1
    python -m replytree2024.cli declare-final-block --config run.json
    python -m replytree2024.cli design-stats  --config run.json
    python -m replytree2024.cli selftest

The configuration is a JSON file. Scientific settings have no defaults: a
missing key stops the run with a message naming it. The final calendar block
can be scored only with --unlock-final, and every such access is appended to
<workdir>/final_block_access.log.
"""

import argparse
import datetime as dt
import itertools
import json
import sys
import time
import zlib
from pathlib import Path

import numpy as np

from . import data, design_stats, g18, g18_fit, g18_sim, intake
from .trees import tree_metrics

BLOCKS = ("training", "development", "final")


def _need(d, keys, where):
    missing = [k for k in keys if k not in d]
    if missing:
        sys.exit(f"configuration error: {where} is missing {', '.join(missing)}; no default is assumed.")


def _load(path):
    cfg = json.loads(Path(path).read_text())
    _need(cfg, ("workdir", "input", "intake"), "the configuration")
    return cfg, Path(cfg["workdir"])


def _records(spec):
    _need(spec, ("format", "paths", "fields", "time_scale"), "input")
    readers = []
    for p in spec["paths"]:
        if spec["format"] == "delimited":
            _need(spec, ("delimiter", "header", "quotechar"), "input")
            readers.append(intake.read_delimited(p, spec["fields"], spec["delimiter"], spec["header"],
                                                 spec["time_scale"], spec["quotechar"]))
        elif spec["format"] == "jsonl":
            readers.append(intake.read_jsonl(p, spec["fields"], spec["time_scale"]))
        else:
            sys.exit("configuration error: input.format must be 'delimited' or 'jsonl'")
    return itertools.chain.from_iterable(readers)


def _source_manifest(spec):
    """What the work directory is bound to: the input description and the hash of every input file."""
    return dict(input={k: v for k, v in spec.items() if k != "paths"},
                files=[dict(name=Path(p).name, bytes=Path(p).stat().st_size, sha256=intake.file_sha256(p))
                       for p in spec["paths"]])


def cmd_intake(args):
    cfg, work = _load(args.config)
    icfg = intake.IntakeConfig.from_dict(cfg["intake"])
    t0 = time.time()
    try:
        part = intake.partition(_records(cfg["input"]), work, icfg, _source_manifest(cfg["input"]))
        ledger = intake.build_all(work, icfg)
    except intake.IntakeError as exc:
        sys.exit(f"intake stopped: {exc}")
    sdir = work / "stats"
    sdir.mkdir(exist_ok=True)
    n_trees = n_posts = 0
    for f, z in intake.iter_tree_files(work):
        out, mark = sdir / f.name, sdir / (f.stem + ".source_sha256")
        src = intake.file_sha256(f)
        if len(z["offsets"]) > 1 and not (out.exists() and mark.exists() and mark.read_text() == src):
            st = data.g18_stats(z["offsets"], z["parents"])
            data.save_stats(out, st)
            mark.write_text(src)
        n_trees += len(z["offsets"]) - 1
        n_posts += int(z["offsets"][-1])
    roots = ledger.get("conversations_kept", 0)
    report = dict(partition=part, build=ledger, trees_with_a_reply=n_trees, posts_in_those_trees=n_posts,
                  kept_roots=roots, share_of_kept_roots_with_a_reply=(n_trees / roots if roots else None),
                  intake_settings=cfg["intake"], seconds=round(time.time() - t0, 1))
    (work / "ledger.json").write_text(json.dumps(report, indent=1) + "\n")
    print(json.dumps(report, indent=1))


def _block_mask(root_time, bounds):
    return (root_time >= bounds[0]) & (root_time < bounds[1])


def _gather(work, bounds, fraction=1.0):
    """Statistics and outcomes of the trees whose root time lies in bounds (hash-sampled by root id)."""
    parts, offset = [], 0
    keep_thr = int(fraction * 2 ** 32)
    for f, z in intake.iter_tree_files(work):
        if len(z["offsets"]) <= 1:
            continue
        st = data.load_stats(work / "stats" / f.name)
        m = _block_mask(z["root_time"], bounds)
        if fraction < 1.0:
            h = np.array([zlib.crc32(("s:" + str(r)).encode()) for r in z["tree_id"]], dtype=np.int64)
            m &= h < keep_thr
        parts.append(data.subset_stats(st, m))
    if not parts:
        sys.exit("no trees found in the requested block")
    cat = lambda name: np.concatenate([getattr(p, name) for p in parts])
    shift = np.r_[0, np.cumsum([p.n_trees for p in parts])]
    return data.G18Stats(
        n_trees=int(shift[-1]), K=cat("K"), C=cat("C"),
        seg_tree=np.concatenate([p.seg_tree + s for p, s in zip(parts, shift)]), seg_a=cat("seg_a"), seg_cnt=cat("seg_cnt"),
        end_tree=np.concatenate([p.end_tree + s for p, s in zip(parts, shift)]), end_role=cat("end_role"),
        end_degree=cat("end_degree"), end_cnt=cat("end_cnt"),
        outcomes={k: np.concatenate([p.outcomes[k] for p in parts]) for k in parts[0].outcomes})


def _fit_settings(cfg):
    _need(cfg, ("blocks", "g18_fit"), "the configuration")
    _need(cfg["blocks"], BLOCKS, "blocks")
    _need(cfg["g18_fit"], ("fit_sample_fraction", "starts"), "g18_fit")
    _check_final_block(Path(cfg["workdir"]), cfg["blocks"], required=False)
    return cfg["blocks"], cfg["g18_fit"]


def cmd_fit(args):
    cfg, work = _load(args.config)
    blocks, fs = _fit_settings(cfg)
    st = _gather(work, blocks["training"], fs["fit_sample_fraction"])
    starts = [(s["label"], s["values"]) for s in fs["starts"]]
    root = g18_fit.fit_root(st.K)
    (work / "fits").mkdir(exist_ok=True)
    out = dict(trees_used=st.n_trees, block=blocks["training"], fit_sample_fraction=fs["fit_sample_fraction"], root=root)
    if root["status"] == "ok":
        base = g18.G18Parameters(**{**root["params"], **starts[0][1]})
        ed = g18.EndData(st.K, st.end_tree, st.end_role, st.end_degree, st.end_cnt)
        cd = g18.ContinuationData(st.K, st.C, st.seg_tree, st.seg_a, st.seg_cnt)
        end = g18_fit.fit_end(ed, base, starts)
        cont = g18_fit.fit_continuation(cd, base, starts)
        out.update(end=end, continuation=cont)
        gate = None
        if end["status"] == "ok" and cont["status"] == "ok":
            P = g18.G18Parameters(**{**root["params"], **end["values"], **cont["values"]})
            gate = g18_fit.numerical_gate(cd, P)
            out.update(parameters={k: getattr(P, k) for k in P.__dataclass_fields__}, numerical_gate=gate,
                       all_starts_converged=bool(all(q["success"] for q in root["runs"] + end["runs"] + cont["runs"])),
                       boundary_hits=root["boundary_hits"] + end["boundary_hits"] + cont["boundary_hits"])
        out["status"] = g18_fit.fit_status(root, end, cont, gate)
    else:
        out["status"] = "unresolved (" + root["status"] + ")"
    (work / "fits" / "g18_fit.json").write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps({k: out.get(k) for k in ("status", "parameters", "trees_used", "all_starts_converged",
                                              "boundary_hits", "numerical_gate")}, indent=1))


def _usable_fit(work):
    """The fitted vector, or stop: an unresolved fit is never scored or simulated."""
    fit = json.loads((work / "fits" / "g18_fit.json").read_text())
    if fit.get("status") != "ok":
        sys.exit(f"refused: the fit is not usable ({fit.get('status')}). Failed starts are kept in g18_fit.json.")
    return g18.G18Parameters.from_dict(fit)


def cmd_score(args):
    cfg, work = _load(args.config)
    blocks, _ = _fit_settings(cfg)
    if args.block == "final":
        if not args.unlock_final:
            sys.exit("refused: the final block is scored only with --unlock-final, after the protocol is locked.")
        with open(work / "final_block_access.log", "a") as fh:
            fh.write(f"{dt.datetime.now().isoformat(timespec='seconds')} score-g18 final\n")
    P = _usable_fit(work)
    st = _gather(work, blocks[args.block])
    root, cont, end = g18.batch_log_probability(st, P, **g18_fit.REFERENCE)
    total = root + cont + end
    out = dict(block=args.block, trees=st.n_trees, mean_log_score_per_tree=dict(
        root=float(root.mean()), continuation=float(cont.mean()), end=float(end.mean()), total=float(total.mean())),
        se_total_treating_trees_as_independent=float(total.std(ddof=1) / np.sqrt(len(total))))
    (work / "fits" / f"g18_score_{args.block}.json").write_text(json.dumps(out, indent=1) + "\n")
    np.savez_compressed(work / "fits" / f"g18_score_{args.block}.npz", root=root, continuation=cont, end=end)
    print(json.dumps(out, indent=1))


def cmd_simulate(args):
    cfg, work = _load(args.config)
    P = _usable_fit(work)
    cols = {k: [] for k in ("size", "depth", "width", "root_degree", "wiener", "max_reply_degree")}

    def consumer(out):
        per, _ = tree_metrics(out["offsets"], out["parents"], segments=False)
        for k in cols:
            cols[k].append(per[k])
    rep = g18_sim.simulate(P, args.n, args.seed, chunk=5000, consumer=consumer, explicit=True)
    arrays = {k: np.concatenate(v) if v else np.zeros(0) for k, v in cols.items()}
    arrays["wiener"] = arrays["wiener"].astype(np.float64)
    (work / "sim").mkdir(exist_ok=True)
    np.savez_compressed(work / "sim" / f"g18_seed{args.seed}.npz", **arrays)
    summary = {k: rep[k] for k in ("trees_requested", "trees_completed", "excess_trees", "aborted_chunks", "aborted_trees")}
    summary["complete"] = rep["trees_completed"] == rep["trees_requested"]
    (work / "sim" / f"g18_seed{args.seed}.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps(summary, indent=1))


def _final_block(blocks):
    final = [float(x) for x in blocks["final"]]
    if len(final) != 2 or not final[0] < final[1]:
        sys.exit("configuration error: blocks.final must be [start, end] with start < end.")
    return final


def _check_final_block(work, blocks, required):
    """Compare the configuration with the final block declared for this work directory.

    The declaration is made once, by `declare-final-block`, and never by a request for results. A
    configuration that names a different final block is refused. This guards against accidents, such
    as a configuration edited between steps; it is not an approval mechanism and cannot stop someone
    who deletes the record. Work directories from before the record existed are accepted by the fit
    and score steps (required=False).
    """
    final = _final_block(blocks)
    path = work / "final_block.json"
    if not path.exists():
        if required:
            sys.exit("refused: no final block has been declared for this work directory. Run "
                     "`declare-final-block --config ...` once, with the agreed calendar blocks, before any statistic.")
        return final
    declared = json.loads(path.read_text())["final"]
    if declared != final:
        sys.exit(f"refused: this work directory was declared with a different final block ({declared}). "
                 "The final block is declared once.")
    return final


def cmd_declare_final(args):
    """Record the reserved final block of this work directory, once."""
    cfg, work = _load(args.config)
    _need(cfg, ("blocks",), "the configuration")
    _need(cfg["blocks"], ("final",), "blocks")
    final = _final_block(cfg["blocks"])
    path = work / "final_block.json"
    work.mkdir(parents=True, exist_ok=True)
    try:
        with open(path, "x") as fh:                  # exclusive: two declarations cannot both succeed
            fh.write(json.dumps(dict(final=final, declared_at=dt.datetime.now().isoformat(timespec="seconds"))) + "\n")
    except FileExistsError:
        _check_final_block(work, cfg["blocks"], required=True)
        print(f"already declared: final block {final}")
        return
    print(f"declared: final block {final}")


def cmd_design_stats(args):
    """Descriptive tables for planning a collection, from the trees of a finished intake run."""
    cfg, work = _load(args.config)
    _need(cfg, ("design_stats", "blocks"), "the configuration")
    _need(cfg["blocks"], ("final",), "blocks (the reserved final block must be declared before any statistic is computed)")
    icfg = intake.IntakeConfig.from_dict(cfg["intake"])
    try:
        dcfg = design_stats.DesignConfig.from_dict(cfg["design_stats"], icfg)
    except ValueError as exc:
        sys.exit(f"configuration error: {exc}")
    bound = work / "build_manifest.json"
    if not bound.exists() or not (work / "ledger.json").exists():
        sys.exit("refused: run the intake step to completion in this work directory first.")
    if json.loads(bound.read_text())["intake"] != cfg["intake"]:
        sys.exit("refused: the trees in this work directory were built with different intake settings.")
    final = _check_final_block(work, cfg["blocks"], required=True)
    a, b = dcfg.window
    overlaps_final = a < final[1] and final[0] < b
    if overlaps_final and not args.unlock_final:
        sys.exit("refused: the window overlaps the final block. Descriptive statistics of the final block are "
                 "an inspection of it; they are computed only with --unlock-final, and the access is logged.")
    try:
        files = intake.verified_tree_files(work)
    except intake.IntakeError as exc:
        sys.exit(f"refused: {exc}")
    # every look at the data is recorded before it happens, and its outcome afterwards
    stamp = lambda: dt.datetime.now().isoformat(timespec="seconds")
    what = (f"design-stats window {a} {b} size_horizon {dcfg.size_horizon_seconds} follow_up {dcfg.follow_up_seconds} "
            f"final_block {'overlapped' if overlaps_final else 'not touched'}")

    def log(event):
        with open(work / "design_stats_access.log", "a") as fh:
            fh.write(f"{stamp()} {event} {what}\n")
    log("started")
    try:
        if overlaps_final:
            with open(work / "final_block_access.log", "a") as fh:
                fh.write(f"{stamp()} design-stats window {a} {b}\n")
        acc = design_stats.Accumulator(dcfg)
        for f in files:
            acc.add_bucket(np.load(f))
        out = acc.result()
        build = json.loads((work / "ledger.json").read_text())["build"]
        out["intake_settings"] = cfg["intake"]
        out["intake_ledger_whole_run"] = {k: build[k] for k in sorted(build) if not k.startswith("disposition: ")}
        out["final_block"] = dict(window=final, overlapped_by_these_statistics=bool(overlaps_final))
        hist = out.pop("size_histogram")
        odir = work / "design_stats"
        odir.mkdir(exist_ok=True)
        tag = f"{a:.0f}_{b:.0f}"
        (odir / f"design_stats_{tag}.json").write_text(json.dumps(out, indent=1) + "\n")
        with open(odir / f"size_histogram_{tag}.csv", "w") as fh:
            fh.write("size,conversations\n" + "".join(f"{s},{n}\n" for s, n in zip(hist["size"], hist["conversations"])))
    except BaseException as exc:
        log(f"failed ({type(exc).__name__})")
        raise
    log("finished")
    print(json.dumps({k: out[k] for k in ("population", "volume_by_size", "quiet_roots", "cutoff_for_cap", "final_block")},
                     indent=1))


def cmd_selftest(args):
    import unittest
    suite = unittest.defaultTestLoader.discover(str(Path(__file__).resolve().parents[1] / "tests"))
    ok = unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful()
    sys.exit(0 if ok else 1)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="replytree2024", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("intake", cmd_intake), ("fit-g18", cmd_fit), ("score-g18", cmd_score),
                     ("simulate-g18", cmd_simulate), ("design-stats", cmd_design_stats), ("declare-final-block", cmd_declare_final),
                     ("selftest", cmd_selftest)):
        p = sub.add_parser(name)
        p.set_defaults(fn=fn)
        if name != "selftest":
            p.add_argument("--config", required=True)
        if name == "score-g18":
            p.add_argument("--block", required=True, choices=BLOCKS)
        if name in ("score-g18", "design-stats"):
            p.add_argument("--unlock-final", action="store_true")
        if name == "simulate-g18":
            p.add_argument("--n", type=int, required=True)
            p.add_argument("--seed", type=int, required=True)
    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
