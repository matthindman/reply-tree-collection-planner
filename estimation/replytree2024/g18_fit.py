"""Maximum-likelihood fitting of the three G18 blocks. Every start is recorded."""

import time

import numpy as np
from scipy.optimize import minimize
from scipy.special import expit, logit

from .g18 import (CONT_NAMES, END_NAMES, G18Parameters, NumericalFailure, continuation_loglik,
                  end_loglik, root_logpmf)

ROOT_BOUNDS = {"w": (0.001, 0.999), "a1": (-30, 15), "t1": (0.01, 5), "a2": (-30, 15), "t2": (0.01, 5)}
ROOT_STARTS = [(.5, 2, .3, .5, .3), (.6, 1.5, .5, -1.5, .7), (.4, 2, .05, .4, .3), (.8, 2.3, .1, 1, .5),
               (.25, 1.5, .4, 1.2, 1.4), (.5, 3, 1, 0, .5), (.7, 1, .2, -3, 1), (.5, .8, .05, 2.5, .05)]
CONT_BOUNDS = {"c0": (-10, 10), "c1": (-1, 3), "s1": (0, 6), "mu": (-10, 10), "gam": (-1, 3),
               "sig": (0, 6), "tau": (0, 6)}
END_BOUNDS = {"g0": (-12, 8), "f0": (-12, 8), "f1": (-3, 3), "alpha0": (1.02, 8), "b1": (-1, 2), "b2": (-1, 2)}
FAST = dict(step=0.6, half_width=12.0, dz=0.02)
REFERENCE = dict(step=0.3, half_width=15.0, dz=0.01)


def boundary_hits(values, bounds, tol=0.01):
    return [k for k, v in values.items() if min(v - bounds[k][0], bounds[k][1] - v) < tol * (bounds[k][1] - bounds[k][0])]


class _Root:
    w: float; a1: float; t1: float; a2: float; t2: float


def _root_ns(z):
    r = _Root()
    r.w, r.a1, r.t1, r.a2, r.t2 = float(expit(z[0])), float(z[1]), float(np.exp(z[2])), float(z[3]), float(np.exp(z[4]))
    return r


def fit_root(K):
    """Exact discrete maximum likelihood for the root mixture, 8 fixed starts."""
    h = np.bincount(np.asarray(K, np.int64))
    k = np.flatnonzero(h)
    k = k[k >= 1]
    mass = h[k] / h[k].sum()
    lo = [logit(ROOT_BOUNDS["w"][0]), ROOT_BOUNDS["a1"][0], np.log(ROOT_BOUNDS["t1"][0]),
          ROOT_BOUNDS["a2"][0], np.log(ROOT_BOUNDS["t2"][0])]
    hi = [logit(ROOT_BOUNDS["w"][1]), ROOT_BOUNDS["a1"][1], np.log(ROOT_BOUNDS["t1"][1]),
          ROOT_BOUNDS["a2"][1], np.log(ROOT_BOUNDS["t2"][1])]
    def f(z):
        try:
            return float(-(mass @ root_logpmf(k.astype(float), _root_ns(z))))
        except NumericalFailure:
            root_failures.append(list(map(float, z)))
            return 1e10
    root_failures = []
    runs = []
    for s in ROOT_STARTS:
        z0 = np.array([logit(s[0]), s[1], np.log(s[2]), s[3], np.log(s[4])])
        r = minimize(f, z0, method="L-BFGS-B", bounds=list(zip(lo, hi)),
                     options=dict(maxiter=2000, ftol=1e-13, gtol=1e-9))
        P = _root_ns(r.x)
        runs.append(dict(start=list(s), params=dict(w=P.w, a1=P.a1, t1=P.t1, a2=P.a2, t2=P.t2), nll=float(r.fun),
                         success=bool(r.success), message=str(r.message), iterations=int(r.nit)))
    ok = [r for r in runs if r["success"]]
    if not ok:
        return dict(status="unresolved: no root start converged", params=None, runs=runs)
    best = min(ok, key=lambda r: r["nll"])
    p = dict(best["params"])
    med = lambda a, t: a / t          # ordering proxy: smaller a/t means heavier component
    if med(p["a1"], p["t1"]) < med(p["a2"], p["t2"]):
        p = dict(w=1 - p["w"], a1=p["a2"], t1=p["t2"], a2=p["a1"], t2=p["t1"])
    return dict(status="ok", params=p, nll_per_tree=best["nll"], runs=runs, boundary_hits=boundary_hits(p, ROOT_BOUNDS),
                starts_converged=len(ok),
                numerical_failures=len(root_failures),
                spread_of_start_nll=float(max(r["nll"] for r in runs) - best["nll"]))


def _fit_block(objective, names, bounds, starts, maxiter, fd_step, jac=False):
    runs = []
    bnd = [bounds[k] for k in names]
    failures = []

    def guarded(x):
        bad = (1e10, np.zeros(len(x))) if jac else 1e10
        try:
            v = objective(x)
        except (NumericalFailure, ValueError) as exc:     # recorded, never silently replaced
            failures.append(dict(x=list(map(float, x)), error=repr(exc)))
            return bad
        if not np.isfinite(v[0] if jac else v):
            failures.append(dict(x=list(map(float, x)), error="non-finite objective"))
            return bad
        return v
    objective_raw, objective_g = objective, guarded
    for label, start in starts:
        x0 = np.clip([start[k] for k in names], [b[0] for b in bnd], [b[1] for b in bnd])
        t0 = time.time()
        opts = dict(maxiter=maxiter, ftol=1e-12, gtol=1e-7, maxfun=20000)
        if not jac:
            opts["eps"] = fd_step
        r = minimize(objective_g, x0, method="L-BFGS-B", jac=jac or None, bounds=bnd, options=opts)
        runs.append(dict(start=label, start_values=dict(zip(names, map(float, x0))),
                         values=dict(zip(names, map(float, r.x))), nll=float(r.fun), success=bool(r.success),
                         message=str(r.message), iterations=int(r.nit), evaluations=int(r.nfev),
                         seconds=round(time.time() - t0, 1)))
    ok = [q for q in runs if q["success"] and q["nll"] < 1e9]
    if not ok:      # failed starts are kept above; nothing is selected from them
        return dict(status="unresolved: no start converged", values=None, nll=None, runs=runs,
                    numerical_failures=failures, starts_reaching_best=0, boundary_hits=[])
    best = min(ok, key=lambda q: q["nll"])
    near = [q for q in ok if q["nll"] - best["nll"] < 1e-6]
    spread = {k: float(max(q["values"][k] for q in near) - min(q["values"][k] for q in near)) for k in names}
    return dict(status="ok", starts_converged=len(ok),
                values=best["values"], nll=best["nll"], runs=runs, numerical_failures=failures,
                starts_reaching_best=len(near), parameter_spread_among_best=spread,
                boundary_hits=boundary_hits(best["values"], bounds))


def _with_fixed(bounds, fixed):
    """Bounds with some parameters held at given values (used for nested rungs)."""
    b = dict(bounds)
    for k, v in (fixed or {}).items():
        b[k] = (float(v), float(v))
    return b


def fit_end(ed, base, starts, maxiter=500, fixed=None):
    """Joint fit of the branch-or-leaf and branch-size terms (six parameters)."""
    n = float(ed.cnt.sum())
    obj = lambda x: -end_loglik(ed, base.replace(**dict(zip(END_NAMES, map(float, x))))) / n
    out = _fit_block(obj, END_NAMES, _with_fixed(END_BOUNDS, fixed), starts, maxiter, 1e-6)
    if fixed:
        out["fixed"] = dict(fixed)
        out["boundary_hits"] = [k for k in out["boundary_hits"] if k not in fixed]
    out["n_endings"] = n
    return out


def fit_continuation(cd, base, starts, maxiter=300, grid=FAST, fixed=None):
    """Fit of the continuation block (seven parameters), latent effects integrated out."""
    n = float(cd.weight.sum())

    def obj(x):
        P = base.replace(**dict(zip(CONT_NAMES, map(float, x))))
        ll, grad = continuation_loglik(cd, P, gradient=True, **grid)
        return -float(cd.weight @ ll) / n, -(cd.weight @ grad) / n
    out = _fit_block(obj, CONT_NAMES, _with_fixed(CONT_BOUNDS, fixed), starts, maxiter, 1e-5, jac=True)
    if fixed:
        out["fixed"] = dict(fixed)
        out["boundary_hits"] = [k for k in out["boundary_hits"] if k not in fixed]
    out["n_trees"] = n
    return out


def gradient_check(objective, x, names, h=1e-4):
    """Central-difference gradient at x, for reporting convergence."""
    x = np.asarray(x, float)
    g = {}
    for i, k in enumerate(names):
        e = np.zeros(len(x)); e[i] = h
        g[k] = float((objective(x + e) - objective(x - e)) / (2 * h))
    return g


FINE = dict(step=0.1, half_width=18.0, dz=0.004, span=24.0)
GATE_PER_TREE = 1e-6      # numerical tolerance on log p(tree | K); not a scientific threshold


def numerical_gate(cd, P):
    """Accuracy of the continuation integral at a fitted vector: optimizer and reference grids against a finer one."""
    fine = continuation_loglik(cd, P, **FINE)
    out = {}
    for name, grid in (("optimizer_grid", FAST), ("reference_grid", REFERENCE)):
        d = continuation_loglik(cd, P, **grid) - fine
        out[name] = dict(max_abs_per_tree=float(np.max(np.abs(d))), total=float(cd.weight @ d))
    out["tolerance_per_tree"] = GATE_PER_TREE
    out["passed"] = bool(out["reference_grid"]["max_abs_per_tree"] < GATE_PER_TREE)
    return out


def fit_status(root, end, cont, gate=None):
    """'ok' only if every block selected a converged start and the numerical gate was run and passed."""
    problems = [f"{n}: {b['status']}" for n, b in (("root", root), ("end", end), ("continuation", cont)) if b["status"] != "ok"]
    if gate is None:
        problems.append("continuation: no numerical gate at the fitted vector")
    elif not gate["passed"]:
        problems.append("continuation: numerical gate failed at the fitted vector")
    return "ok" if not problems else "unresolved (" + "; ".join(problems) + ")"


SE_STABILITY_TOLERANCE = 0.10     # largest allowed relative change of a standard error between two step sizes


def standard_errors(stats, P):
    """Tree-clustered (sandwich) covariance of the 13 process parameters, or an explicit unresolved status.

    Conversations are the independent units (decision D30). If conversations share authors or events
    the result can be too small or too large; the sign is not guaranteed. The covariance is joint over
    the continuation and end blocks: their information is block-diagonal, but their per-tree scores are
    correlated, so derived quantities that use both blocks need the off-diagonal part returned here.
    The root block is not included.

    Fails closed. No variance is clipped. The result is 'unresolved' if the information matrix is not
    finite or not positive definite, if any variance is not positive, if a parameter lies on a bound, or
    if the standard errors change by more than SE_STABILITY_TOLERANCE between two finite-difference steps.
    """
    from .g18 import ContinuationData, EndData, _end_terms
    n = float(stats.n_trees)
    names = CONT_NAMES + END_NAMES
    bounds = {**CONT_BOUNDS, **END_BOUNDS}
    x = np.array([getattr(P, k) for k in names])
    on_bound = [k for k, v in zip(names, x) if min(v - bounds[k][0], bounds[k][1] - v) < 0.01 * (bounds[k][1] - bounds[k][0])]
    out = dict(trees=int(n), parameters=list(names), estimates=dict(zip(names, map(float, x))), on_bound=on_bound,
               note="Sandwich covariance with conversations as independent units (D30); root block not included.")
    if on_bound:
        out["status"] = "unresolved: parameter on a bound (" + ", ".join(on_bound) + ")"
        return out
    cd = ContinuationData(stats.K, stats.C, stats.seg_tree, stats.seg_a, stats.seg_cnt)
    ed = EndData(stats.K, stats.end_tree, stats.end_role, stats.end_degree, stats.end_cnt)
    xc, xe = x[:7], x[7:]
    K_end = stats.K[stats.end_tree].astype(float)

    def cont_score(v):
        _, g = continuation_loglik(cd, P.replace(**dict(zip(CONT_NAMES, map(float, v)))), gradient=True, **REFERENCE)
        return g

    def end_terms(v):
        return _end_terms(stats.end_role, K_end, stats.end_degree, P.replace(**dict(zip(END_NAMES, map(float, v)))))

    def end_total(v):
        return end_loglik(ed, P.replace(**dict(zip(END_NAMES, map(float, v))))) / n
    # per-tree scores (continuation: analytic; end: central differences of per-ending terms)
    G = cont_score(xc)[cd.inverse]
    S = np.empty((stats.n_trees, 6))
    for i in range(6):
        e = np.zeros(6); e[i] = 1e-4
        d = (end_terms(xe + e) - end_terms(xe - e)) / 2e-4
        S[:, i] = np.bincount(stats.end_tree, weights=d * stats.end_cnt, minlength=stats.n_trees)
    scores = np.c_[G, S]
    B = scores.T @ scores / n

    def information(hc, he):
        Hc = np.empty((7, 7))
        for i in range(7):
            e = np.zeros(7); e[i] = hc
            Hc[i] = ((cd.weight @ cont_score(xc + e)) - (cd.weight @ cont_score(xc - e))) / (2 * hc * n)
        He = np.empty((6, 6))
        for i in range(6):
            for j in range(i, 6):
                ei = np.zeros(6); ej = np.zeros(6); ei[i] = he; ej[j] = he
                He[i, j] = He[j, i] = (end_total(xe + ei + ej) - end_total(xe + ei - ej)
                                       - end_total(xe - ei + ej) + end_total(xe - ei - ej)) / (4 * he * he)
        A = np.zeros((13, 13))
        A[:7, :7] = -0.5 * (Hc + Hc.T)
        A[7:, 7:] = -He
        return A

    def covariance(A):
        if not np.all(np.isfinite(A)):
            return None, "information matrix is not finite"
        eig = np.linalg.eigvalsh(A)
        if eig.min() <= 0:
            return None, f"information matrix is not positive definite (smallest eigenvalue {eig.min():.3e})"
        Ainv = np.linalg.inv(A)
        cov = Ainv @ B @ Ainv / n
        if not np.all(np.isfinite(cov)) or np.any(np.diag(cov) <= 0):
            return None, "a variance is not positive"
        return cov, None
    A1 = information(1e-4, 1e-3)
    cov, err = covariance(A1)
    if err:
        out["status"] = "unresolved: " + err
        return out
    A2 = information(3e-4, 3e-3)
    cov2, err2 = covariance(A2)
    if err2:
        out["status"] = "unresolved at the second step size: " + err2
        return out
    se, se2 = np.sqrt(np.diag(cov)), np.sqrt(np.diag(cov2))
    change = float(np.max(np.abs(se2 / se - 1)))
    out.update(max_relative_change_of_se_between_step_sizes=change, stability_tolerance=SE_STABILITY_TOLERANCE,
               condition_number_of_information=float(np.linalg.cond(A1)))
    if change > SE_STABILITY_TOLERANCE:
        out["status"] = "unresolved: standard errors are not stable to the finite-difference step"
        return out
    Ainv = np.linalg.inv(A1)
    out.update(status="ok", se=dict(zip(names, map(float, se))),
               se_if_model_were_correct=dict(zip(names, map(float, np.sqrt(np.diag(Ainv) / n)))),
               covariance=cov.tolist())
    return out
