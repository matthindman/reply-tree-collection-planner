"""From post records to reply trees, in bounded memory, with an integrity ledger.

Input is a stream of records with five fields:
    post_id, parent_id (empty for a root), root_id (conversation id), time, author
in any order. Records are partitioned on disk by a hash of root_id
(`partition`), so that each bucket holds whole conversations; each bucket is
then turned into trees (`build_bucket`).

Rules of this module:
  * Nothing scientific is defaulted. Every setting in REQUIRED must be given.
  * The result must not depend on the order of the input. Exact duplicate
    records are dropped and counted; a post id that appears with different
    content, or under two conversations, quarantines the conversations involved.
  * Every record is either used or counted in the ledger under a named reason.
    Ledger keys that start with "disposition: " are disjoint and sum to the
    records in the buckets (checked for every bucket). All other keys are
    diagnostic counts and may overlap.
  * A work directory is bound to a manifest (source files and their hashes,
    field mapping, intake settings). A restart with a different manifest is
    refused, and a finished bucket is reused only if its output hash matches.
  * A bucket larger than max_bucket_records stops the run. Memory safety at
    national scale is not claimed beyond that guard.

A root id is required on every record. Reconstructing conversations from
parent links alone needs a global join that this module does not attempt.
"""

import csv
import gzip
import hashlib
import io
import json
import math
import os
import zlib
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

MISSING_PARENT_RULES = ("quarantine_tree", "drop_subtree", "attach_to_root")
TIME_RULES = ("keep", "quarantine_tree")
CYCLE_RULES = ("quarantine_tree", "drop_component")
REQUIRED = ("cohort_start", "cohort_end", "observation_end", "horizon_seconds",
            "missing_parent_rule", "reply_before_parent_rule", "cycle_rule",
            "n_buckets", "max_bucket_records", "max_malformed_records")


class IntakeError(RuntimeError):
    """The run cannot continue without a decision by the analyst."""


@dataclass(frozen=True)
class IntakeConfig:
    cohort_start: float          # roots with cohort_start <= time < cohort_end are eligible
    cohort_end: float
    observation_end: float       # last instant at which a reply could have been recorded
    horizon_seconds: object      # float, or None stated explicitly: "trees as collected"
    missing_parent_rule: str
    reply_before_parent_rule: str
    cycle_rule: str
    n_buckets: int
    max_bucket_records: int      # a larger bucket stops the run
    max_malformed_records: int   # more malformed input records than this stops the run

    @classmethod
    def from_dict(cls, d):
        missing = [k for k in REQUIRED if k not in d]
        if missing:
            raise ValueError("intake configuration is missing required settings: " + ", ".join(missing)
                             + ". No default is assumed for any of them.")
        c = cls(**{k: d[k] for k in REQUIRED})
        if c.missing_parent_rule not in MISSING_PARENT_RULES:
            raise ValueError(f"missing_parent_rule must be one of {MISSING_PARENT_RULES}")
        if c.reply_before_parent_rule not in TIME_RULES:
            raise ValueError(f"reply_before_parent_rule must be one of {TIME_RULES}")
        if c.cycle_rule not in CYCLE_RULES:
            raise ValueError(f"cycle_rule must be one of {CYCLE_RULES}")
        for k in ("cohort_start", "cohort_end", "observation_end"):
            if isinstance(getattr(c, k), bool) or not isinstance(getattr(c, k), (int, float)) \
                    or not math.isfinite(getattr(c, k)):
                raise ValueError(f"{k} must be a finite number")
        if c.horizon_seconds is not None and (isinstance(c.horizon_seconds, bool)
                                              or not isinstance(c.horizon_seconds, (int, float))
                                              or not math.isfinite(c.horizon_seconds)):
            raise ValueError("horizon_seconds must be a finite number or null")
        if not c.cohort_start < c.cohort_end <= c.observation_end:
            raise ValueError("require cohort_start < cohort_end <= observation_end")
        if c.horizon_seconds is not None and c.horizon_seconds <= 0:
            raise ValueError("horizon_seconds must be positive, or null to use trees as collected")
        if int(c.n_buckets) < 1 or int(c.max_bucket_records) < 1 or int(c.max_malformed_records) < 0:
            raise ValueError("n_buckets and max_bucket_records must be positive; max_malformed_records >= 0")
        return c


def _digest(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True).encode("utf-8")).hexdigest()


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while chunk := fh.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


# ------------------------------------------------------------------ readers
class Malformed(Exception):
    pass


def _open_text(path):
    raw = open(path, "rb")
    if str(path).endswith(".gz"):
        raw = gzip.GzipFile(fileobj=raw)
    return io.TextIOWrapper(raw, encoding="utf-8", newline="")


def read_delimited(path, fields, delimiter, header, time_scale, quotechar):
    """Yield 5-tuples, or Malformed instances, from a delimited text file (csv rules).

    fields maps the five names to column names (header True) or positions.
    quotechar is the quote character, or None for no quoting.
    """
    with _open_text(path) as fh:
        rd = csv.reader(fh, delimiter=delimiter, quotechar=quotechar or None,
                        quoting=csv.QUOTE_MINIMAL if quotechar else csv.QUOTE_NONE)
        if header:
            names = next(rd)
            pos = {k: (names.index(v) if v is not None else None) for k, v in fields.items()}
            width = len(names)
        else:
            pos, width = dict(fields), None
        for row in rd:
            try:
                if width is not None and len(row) != width:
                    raise ValueError("wrong number of columns")
                yield (row[pos["post_id"]], row[pos["parent_id"]], row[pos["root_id"]],
                       float(row[pos["time"]]) * time_scale,
                       row[pos["author"]] if pos.get("author") is not None else "")
            except (ValueError, IndexError) as exc:
                yield Malformed(repr(exc))


def read_jsonl(path, fields, time_scale):
    """Yield 5-tuples, or Malformed instances, from JSON lines."""
    with _open_text(path) as fh:
        for line in fh:
            try:
                o = json.loads(line)
                parent = o.get(fields["parent_id"])
                author = o.get(fields["author"]) if fields.get("author") else None
                text = lambda v: "" if v in (None, "") else str(v)     # JSON null stays missing
                yield (text(o[fields["post_id"]]), text(parent), text(o[fields["root_id"]]),
                       float(o[fields["time"]]) * time_scale, text(author))
            except (ValueError, KeyError, TypeError) as exc:
                yield Malformed(repr(exc))


# ---------------------------------------------------------------- partition
def _bucket(key, n):
    return zlib.crc32(str(key).encode("utf-8")) % n


def partition(records, workdir, cfg, manifest, flush_every=200_000):
    """Write records into hash buckets, bound to `manifest`. Returns the partition ledger.

    Two sets of bucket files are written: full records keyed by root id, and
    (post id, root id) pairs keyed by post id, used to find a post id that
    appears under two conversations.
    """
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    bound = dict(manifest=manifest, n_buckets=cfg.n_buckets, max_malformed_records=cfg.max_malformed_records)
    mpath = workdir / "partition_manifest.json"
    done = workdir / "partition_done.json"
    if mpath.exists():
        if json.loads(mpath.read_text()) != bound:
            raise IntakeError("this work directory was partitioned from different inputs or settings; "
                              "use a new work directory")
        if done.exists():
            return json.loads(done.read_text())
    bdir, pdir = workdir / "buckets", workdir / "post_index"
    for d in (bdir, pdir):
        d.mkdir(exist_ok=True)
        for old in d.glob("b*.jsonl"):
            old.unlink()                          # a partial partition is never reused
    mpath.write_text(json.dumps(bound, indent=1, sort_keys=True) + "\n")
    n = cfg.n_buckets
    rec_buf = [[] for _ in range(n)]
    idx_buf = [[] for _ in range(n)]
    ledger = Counter()

    def flush():
        for bufs, d in ((rec_buf, bdir), (idx_buf, pdir)):
            for i, buf in enumerate(bufs):
                if buf:
                    with open(d / f"b{i:05d}.jsonl", "a", encoding="utf-8") as fh:
                        fh.write("".join(buf))
                    buf.clear()
    pending = 0
    for rec in records:
        ledger["records_read"] += 1
        if isinstance(rec, Malformed):
            ledger["malformed_records"] += 1
            if ledger["malformed_records"] > cfg.max_malformed_records:
                raise IntakeError(f"more than {cfg.max_malformed_records} malformed input records; last: {rec}")
            continue
        post_id, parent_id, root_id, t, author = rec
        if root_id in ("", None) or post_id in ("", None):
            ledger["records_without_post_or_root_id"] += 1
            continue
        rec_buf[_bucket(root_id, n)].append(json.dumps([root_id, post_id, parent_id or "", t, author or ""]) + "\n")
        idx_buf[_bucket(post_id, n)].append(json.dumps([post_id, root_id]) + "\n")
        pending += 1
        if pending >= flush_every:
            flush()
            pending = 0
    flush()
    # post ids that appear under more than one conversation
    conflicted = set()
    for f in sorted(pdir.glob("b*.jsonl")):
        seen = {}
        with open(f, encoding="utf-8") as fh:
            for i, line in enumerate(fh):
                if i >= cfg.max_bucket_records:
                    raise IntakeError(f"post index {f.name} holds more than max_bucket_records = "
                                      f"{cfg.max_bucket_records} records; increase n_buckets in a new work directory")
                post_id, root_id = json.loads(line)
                other = seen.setdefault(post_id, root_id)
                if other != root_id:
                    conflicted.update((other, root_id))
                    ledger["post_ids_under_more_than_one_conversation"] += 1
    (workdir / "conversations_sharing_a_post_id.json").write_text(json.dumps(sorted(conflicted)) + "\n")
    out = dict(ledger)
    out["conversations_sharing_a_post_id"] = len(conflicted)
    out["records_written_to_buckets"] = (ledger["records_read"] - ledger["malformed_records"]
                                         - ledger["records_without_post_or_root_id"])
    # hashes of the intermediate files: a missing or altered bucket is detected before it is used
    out["bucket_sha256"] = {f.name: file_sha256(f) for f in sorted(bdir.glob("b*.jsonl"))}
    out["shared_post_list_sha256"] = file_sha256(workdir / "conversations_sharing_a_post_id.json")
    done.write_text(json.dumps(out, indent=1) + "\n")
    return out


# -------------------------------------------------------------------- build
def _author_hash(a):
    """Stable 63-bit pseudonym of an author string; -1 for a missing author."""
    if a == "":
        return -1
    return int.from_bytes(hashlib.blake2b(a.encode("utf-8"), digest_size=8).digest(), "big") >> 1


def build_tree(root_id, recs, cfg, ledger):
    """One conversation -> (parents, rel_times, authors, root_time) or None.

    recs is a list of (post_id, parent_id, time, author). Children are ordered
    by (time, post_id), which fixes one plane-tree realization independently
    of the order of the input.
    """
    seen = {}
    conflict = False
    for post_id, parent_id, t, author in recs:
        cur = (parent_id, t, author)
        old = seen.get(post_id)
        if old is None:
            seen[post_id] = cur
        elif old == cur or (old[0] == cur[0] and old[2] == cur[2] and
                            isinstance(t, float) and math.isnan(t) and math.isnan(old[1])):
            ledger["exact_duplicate_records_dropped"] += 1
        else:
            conflict = True
            ledger["duplicate_records_with_conflicting_content"] += 1
    n_rec = len(recs)

    def out(reason):                  # every record of this conversation goes to exactly one disposition
        ledger["disposition: " + reason] += n_rec
        return None
    if conflict:
        ledger["conversations_quarantined_conflicting_duplicate"] += 1
        ledger["records_in_conversations_quarantined_conflicting_duplicate"] += n_rec
        return out("conversation quarantined, conflicting duplicate")
    dup = n_rec - len(seen)
    if any(not math.isfinite(v[1]) for v in seen.values()):
        ledger["conversations_quarantined_nonfinite_time"] += 1
        ledger["posts_in_conversations_quarantined_nonfinite_time"] += len(seen)
        return out("conversation quarantined, non-finite time")
    if root_id not in seen:
        ledger["conversations_without_root_record"] += 1
        ledger["posts_in_conversations_without_root_record"] += len(seen)
        return out("conversation without a root record")
    if seen[root_id][0] != "":
        ledger["conversations_whose_root_record_has_a_parent"] += 1
        ledger["posts_in_conversations_whose_root_has_a_parent"] += len(seen)
        return out("conversation whose root record has a parent")
    t0 = seen[root_id][1]
    ledger["roots_seen"] += 1
    if not (cfg.cohort_start <= t0 < cfg.cohort_end):
        ledger["roots_outside_cohort_window"] += 1
        ledger["posts_under_roots_outside_cohort_window"] += len(seen)
        return out("root outside the cohort window")
    H = cfg.horizon_seconds
    if H is not None and t0 + H > cfg.observation_end:
        ledger["roots_without_full_horizon_of_follow_up"] += 1
        ledger["posts_under_roots_without_full_horizon"] += len(seen)
        return out("root without a full horizon of follow-up")
    kids = {}
    orphans = []                                  # replies whose parent is not in the data
    for post_id, (parent_id, t, _) in seen.items():
        if post_id == root_id:
            continue
        if parent_id == "" or parent_id not in seen:
            if parent_id == "":
                ledger["second_root_records_in_conversation"] += 1
            orphans.append(post_id)
        else:
            kids.setdefault(parent_id, []).append(post_id)
    if orphans and cfg.missing_parent_rule == "quarantine_tree":
        ledger["conversations_quarantined_missing_parent"] += 1
        ledger["posts_in_conversations_quarantined_missing_parent"] += len(seen)
        return out("conversation quarantined, missing parent")
    if orphans:
        ledger["replies_with_missing_parent"] += len(orphans)
        if cfg.missing_parent_rule == "attach_to_root":
            ledger["replies_reattached_to_root"] += len(orphans)
            kids.setdefault(root_id, []).extend(orphans)
    # posts not connected to the root or to an orphan lie on, or hang from, a cycle
    reach = set()
    stack = [root_id] + orphans
    while stack:
        v = stack.pop()
        if v in reach:
            continue
        reach.add(v)
        stack.extend(kids.get(v, ()))
    in_cycles = len(seen) - len(reach)
    if in_cycles:
        ledger["conversations_with_a_cycle"] += 1
        if cfg.cycle_rule == "quarantine_tree":
            ledger["conversations_quarantined_cycle"] += 1
            ledger["posts_in_conversations_quarantined_cycle"] += len(seen)
            return out("conversation quarantined, cycle")
        ledger["posts_dropped_in_cycle_components"] += in_cycles
    under_orphans = 0
    if orphans and cfg.missing_parent_rule == "drop_subtree":
        under_orphans = sum(1 + _descendants(o, kids) for o in orphans)
        ledger["posts_dropped_under_missing_parent"] += under_orphans
    order, parents, index = [root_id], [-1], {root_id: 0}
    head = 0
    while head < len(order):
        node = order[head]
        for child in sorted(kids.get(node, ()), key=lambda c: (seen[c][1], c)):
            tc = seen[child][1]
            if tc > cfg.observation_end:
                ledger["posts_dropped_after_observation_end_or_under_one"] += 1 + _descendants(child, kids)
                continue
            if H is not None and tc - t0 > H:
                ledger["posts_dropped_beyond_horizon_or_under_one"] += 1 + _descendants(child, kids)
                continue
            if tc < seen[node][1]:
                ledger["replies_dated_before_their_parent"] += 1
                if cfg.reply_before_parent_rule == "quarantine_tree":
                    ledger["conversations_quarantined_time_order"] += 1
                    ledger["posts_in_conversations_quarantined_time_order"] += len(seen)
                    return out("conversation quarantined, reply dated before its parent")
            index[child] = len(order)
            order.append(child)
            parents.append(index[node])
        head += 1
    ledger["conversations_kept"] += 1
    ledger["posts_kept"] += len(order)
    ledger["exact_duplicates_in_kept_conversations"] += dup
    ledger["disposition: post kept"] += len(order)
    ledger["disposition: exact duplicate copy in a kept conversation"] += dup
    ledger["disposition: dropped from a kept conversation (missing parent, cycle, endpoint or horizon)"] += \
        len(seen) - len(order)
    times = [seen[v][1] - t0 for v in order]
    authors = [_author_hash(seen[v][2]) for v in order]
    return parents, times, authors, t0


def _descendants(node, kids):
    n, stack = 0, list(kids.get(node, ()))
    seen = set()
    while stack:
        v = stack.pop()
        if v in seen:
            continue
        seen.add(v)
        n += 1
        stack.extend(kids.get(v, ()))
    return n


def build_bucket(path, cfg, shared_post_roots=frozenset()):
    """All conversations of one bucket file -> dict of arrays and a ledger."""
    convs = {}
    n_records = 0
    with open(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            n_records += 1
            if n_records > cfg.max_bucket_records:
                raise IntakeError(f"{Path(path).name} holds more than max_bucket_records = "
                                  f"{cfg.max_bucket_records} records; increase n_buckets in a new work directory")
            root_id, post_id, parent_id, t, author = json.loads(line)
            convs.setdefault(root_id, []).append((post_id, parent_id, float(t), author))
    ledger = Counter(records_in_bucket=n_records)
    ids, sizes, par, tim, auth, root_time, n_auth, n_noauth = [], [], [], [], [], [], [], []
    all_id, all_time, all_size = [], [], []
    for root_id in sorted(convs):
        if root_id in shared_post_roots:
            ledger["conversations_quarantined_post_id_shared_with_another"] += 1
            ledger["records_in_conversations_quarantined_post_id_shared"] += len(convs[root_id])
            ledger["disposition: conversation quarantined, post id shared with another"] += len(convs[root_id])
            continue
        tree = build_tree(root_id, convs[root_id], cfg, ledger)
        if tree is None:
            continue
        parents, times, authors, t0 = tree
        all_id.append(root_id); all_time.append(t0); all_size.append(len(parents))
        if len(parents) == 1:
            ledger["kept_roots_with_no_reply"] += 1
            continue                              # in the root table; the tree model starts at K >= 1
        known = {a for a in authors if a != -1}
        missing = sum(1 for a in authors if a == -1)
        ids.append(root_id); sizes.append(len(parents)); root_time.append(t0)
        par.extend(parents); tim.extend(times); auth.extend(authors)
        n_auth.append(len(known)); n_noauth.append(missing)
        if missing:
            ledger["kept_conversations_with_some_author_missing"] += 1
        elif len(known) == 1:
            ledger["kept_conversations_with_one_author"] += 1
    disjoint = sum(v for k, v in ledger.items() if k.startswith("disposition: "))
    if disjoint != n_records:
        raise IntakeError(f"{Path(path).name}: {n_records} records read but {disjoint} accounted for")
    arrays = dict(
        tree_id=np.array(ids, dtype=str), offsets=np.r_[0, np.cumsum(sizes)].astype(np.int64),
        parents=np.array(par, dtype=np.int32), rel_time=np.array(tim, dtype=np.float64),
        author=np.array(auth, dtype=np.int64),            # stable pseudonym; -1 = missing
        root_time=np.array(root_time, dtype=np.float64), n_authors=np.array(n_auth, dtype=np.int32),
        n_posts_without_author=np.array(n_noauth, dtype=np.int32),
        # every kept root, including those with no reply: the denominator for "share of roots answered"
        all_root_id=np.array(all_id, dtype=str), all_root_time=np.array(all_time, dtype=np.float64),
        all_root_size=np.array(all_size, dtype=np.int64))
    return arrays, dict(ledger)


def build_all(workdir, cfg):
    """Build every bucket, reusing a finished one only if its recorded hash matches."""
    workdir = Path(workdir)
    if not (workdir / "partition_done.json").exists():
        raise IntakeError("partition has not finished in this work directory")
    bound = dict(intake=asdict(cfg), partition=_digest(json.loads((workdir / "partition_manifest.json").read_text())))
    mpath = workdir / "build_manifest.json"
    if mpath.exists() and json.loads(mpath.read_text()) != bound:
        raise IntakeError("trees in this work directory were built with different intake settings; "
                          "use a new work directory")
    mpath.write_text(json.dumps(bound, indent=1, sort_keys=True) + "\n")
    part = json.loads((workdir / "partition_done.json").read_text())
    present = {f.name: f for f in (workdir / "buckets").glob("b*.jsonl")}
    if set(present) != set(part["bucket_sha256"]):
        raise IntakeError("the set of bucket files differs from the one recorded at partition")
    for name, digest in part["bucket_sha256"].items():
        if file_sha256(present[name]) != digest:
            raise IntakeError(f"bucket {name} does not match the hash recorded at partition")
    if file_sha256(workdir / "conversations_sharing_a_post_id.json") != part["shared_post_list_sha256"]:
        raise IntakeError("the list of conversations sharing a post id was altered after partition")
    shared = frozenset(json.loads((workdir / "conversations_sharing_a_post_id.json").read_text()))
    tdir = workdir / "trees"
    tdir.mkdir(exist_ok=True)
    total = Counter()
    for b in sorted((workdir / "buckets").glob("b*.jsonl")):
        out, led = tdir / (b.stem + ".npz"), tdir / (b.stem + ".ledger.json")
        reuse = False
        if out.exists() and led.exists():
            prev = json.loads(led.read_text())
            reuse = prev.get("output_sha256") == file_sha256(out)
        if not reuse:
            arrays, ledger = build_bucket(b, cfg, shared)
            tmp = tdir / (b.stem + ".tmp.npz")
            np.savez_compressed(tmp, **arrays)
            os.replace(tmp, out)                  # atomic: a bucket is either done or absent
            led.write_text(json.dumps(dict(counts=ledger, output_sha256=file_sha256(out)), indent=1) + "\n")
        total.update(json.loads(led.read_text())["counts"])
    return dict(total)


def iter_tree_files(workdir):
    for f in sorted((Path(workdir) / "trees").glob("b*.npz")):
        yield f, np.load(f)


def verified_tree_files(workdir):
    """Paths of the tree files of every bucket, after checking that none is missing or altered.

    A tree file is accepted only if it exists for every bucket of the partition and matches the
    hash recorded when it was built, so that a statistic is never computed on part of the data.
    """
    workdir = Path(workdir)
    for name in ("partition_done.json", "build_manifest.json"):
        if not (workdir / name).exists():
            raise IntakeError("the intake step has not finished in this work directory")
    part = json.loads((workdir / "partition_done.json").read_text())
    files = []
    for name in sorted(part["bucket_sha256"]):
        stem = Path(name).stem
        out, led = workdir / "trees" / (stem + ".npz"), workdir / "trees" / (stem + ".ledger.json")
        if not (out.exists() and led.exists()):
            raise IntakeError(f"the trees of bucket {stem} are missing; run the intake step again")
        if json.loads(led.read_text()).get("output_sha256") != file_sha256(out):
            raise IntakeError(f"trees/{stem}.npz does not match the hash recorded when it was built")
        files.append(out)
    extra = sorted(set(f.name for f in (workdir / "trees").glob("b*.npz")) - set(f.name for f in files))
    if extra:
        raise IntakeError("tree files that belong to no bucket of the partition: " + ", ".join(extra))
    return files
