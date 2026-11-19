"""G18 reply-tree model: parameters, root law, and the integrated likelihood
of fully observed trees (derivation: claude/design_audit/plan/LIKELIHOOD_NOTE.md).

log p(tree) = log p(K)                               root block
            + log E_theta[ continuation terms ]      continuation block
            + branch-or-leaf and branch-size terms   end block

Only the continuation block needs integration: one integral over the
conversation effect theta per tree, over a product of one-dimensional
integrals J(a; z) over the segment effect epsilon. The end block shares the
branch exponent between the branch probability and the branch-size law, so it
is one block, not two.

Convention: log p(tree | K) is the product of per-post offspring
probabilities for the given parent array. No factor is included for the
number of orderings of a post's children (it does not depend on parameters).
"""

from dataclasses import dataclass, asdict, fields
from typing import NamedTuple

import numpy as np
from scipy.special import expit, log_ndtr, logsumexp, zeta

from .data import G18Stats, flatten, g18_stats

LOG_SQRT_2PI = 0.5 * np.log(2 * np.pi)
SQRT2 = np.sqrt(2.0)
ROOT_NAMES = ("w", "a1", "t1", "a2", "t2")
CONT_NAMES = ("c0", "c1", "s1", "mu", "gam", "sig", "tau")
END_NAMES = ("g0", "f0", "f1", "alpha0", "b1", "b2")


@dataclass(frozen=True)
class G18Parameters:
    w: float; a1: float; t1: float; a2: float; t2: float          # root mixture
    alpha0: float; b1: float; b2: float                          # branch size
    c0: float; c1: float; s1: float; g0: float                   # direct replies
    mu: float; gam: float; sig: float; tau: float; f0: float; f1: float  # later posts

    def __post_init__(self):
        v = asdict(self)
        if not all(np.isfinite(x) for x in v.values()):
            raise ValueError("All parameters must be finite")
        if not (0 < self.w < 1 and self.t1 > 0 and self.t2 > 0):
            raise ValueError("Require 0<w<1 and t1,t2>0")
        if self.alpha0 <= 1:
            raise ValueError("alpha0 must exceed 1")
        if min(self.s1, self.sig, self.tau) < 0:
            raise ValueError("s1, sig and tau must be nonnegative")

    @classmethod
    def from_dict(cls, d):
        d = d.get("parameters", d)
        return cls(**{f.name: float(d[f.name]) for f in fields(cls)})

    def replace(self, **kw):
        d = asdict(self); d.update(kw)
        return G18Parameters(**d)


def _logsig(y):
    return -np.logaddexp(0.0, -y)


def _log1msig(y):
    return -np.logaddexp(0.0, y)


# ------------------------------------------------------------------ root block
def _component_logsf(k, a, t):
    y0 = a / t
    return log_ndtr(-(t * np.log(k) + y0)) - log_ndtr(-y0)


class NumericalFailure(FloatingPointError):
    """A probability could not be represented; callers must record it, not hide it."""


def root_logpmf(k, P):
    """log P(K = k), k >= 1, for the two-component truncated lognormal mixture.

    Computed in the log domain (no floor). K must be a positive integer.
    """
    k = np.asarray(k, float)
    if np.any(k < 1) or np.any(k != np.floor(k)):
        raise ValueError("root degree must be a positive integer")
    comps = []
    for wj, a, t in ((P.w, P.a1, P.t1), (1 - P.w, P.a2, P.t2)):
        s0 = _component_logsf(k, a, t)
        s1 = _component_logsf(k + 1, a, t)
        with np.errstate(divide="ignore"):
            comps.append(np.log(wj) + s0 + np.log(-np.expm1(s1 - s0)))
    out = np.logaddexp(comps[0], comps[1])
    if not np.all(np.isfinite(out)):
        raise NumericalFailure("root probability underflowed in both components")
    return out


# ------------------------------------------------------------- segment integral
def _grid(step, half_width):
    """Uniform quadrature nodes in scaled units. The trapezoid rule on a uniform
    grid converges geometrically for these integrands (analytic near the real
    line, rapidly decaying), and unlike Gauss-Hermite it is not degraded by the
    poles of the logistic function when the latent effects are strong."""
    n = int(round(half_width / step))
    return step * np.arange(-n, n + 1)


def log_J(a, z, tau, step=0.3, half_width=15.0, block=4000, with_tau=False):
    """log J(a; z) and d/dz log J, J = E_eps[ L(z+tau*eps)^a (1 - L(z+tau*eps)) ].

    L is the logistic function and eps ~ N(0,1). The integrand is log-concave;
    the grid is centred at its mode and scaled by its curvature there, so the
    result stays accurate for long chains whose integrand sits far in the tail.
    Work is done in blocks so memory does not grow with the table size.
    """
    a, z = np.broadcast_arrays(np.asarray(a, float), np.asarray(z, float))
    if tau == 0:
        L = expit(z)
        out = (a * _logsig(z) + _log1msig(z), a * (1 - L) - L)
        return out + (np.zeros_like(z),) if with_tau else out
    shape = a.shape
    a, z = a.ravel(), z.ravel()
    f = np.empty(len(a)); d = np.empty(len(a)); dt = np.empty(len(a))
    x = _grid(step, half_width)
    for lo in range(0, len(a), block):
        ab, zb = a[lo:lo + block], z[lo:lo + block]
        eps = np.zeros_like(zb)
        for _ in range(100):
            L = expit(zb + tau * eps)
            g = tau * (ab * (1 - L) - L) - eps
            H = -tau * tau * (ab + 1) * L * (1 - L) - 1.0
            delta = np.clip(g / H, -3.0, 3.0)
            eps = eps - delta
            if np.max(np.abs(delta)) < 1e-11:
                break
        L = expit(zb + tau * eps)
        s = 1.0 / np.sqrt(tau * tau * (ab + 1) * L * (1 - L) + 1.0)
        e = eps[:, None] + s[:, None] * x
        y = zb[:, None] + tau * e
        lw = ab[:, None] * _logsig(y) + _log1msig(y) - 0.5 * e * e
        tot = logsumexp(lw, axis=1)
        Ly = expit(y)
        post = np.exp(lw - tot[:, None])
        score = ab[:, None] * (1 - Ly) - Ly
        d[lo:lo + block] = np.sum(post * score, axis=1)
        dt[lo:lo + block] = np.sum(post * score * e, axis=1)
        f[lo:lo + block] = tot + np.log(step * s) - LOG_SQRT_2PI
    if with_tau:
        return f.reshape(shape), d.reshape(shape), dt.reshape(shape)
    return f.reshape(shape), d.reshape(shape)


class _JTable:
    """log J(a; z) on a uniform z grid for the distinct a present in the data."""

    def __init__(self, a_values, zmin, zmax, tau, dz):
        # Snap the grid to multiples of dz so that interpolation error varies
        # smoothly when parameters change (matters for finite-difference gradients).
        z0 = dz * (np.floor(zmin / dz) - 1)
        n = int(np.ceil((zmax - z0) / dz)) + 3
        self.z0, self.dz = z0, dz
        z = self.z0 + dz * np.arange(n)
        self.f, self.d, self.dt = log_J(np.asarray(a_values, float)[:, None], z[None, :], tau, with_tau=True)
        self.d2 = np.gradient(self.d, dz, axis=1, edge_order=2)
        self.dt2 = np.gradient(self.dt, dz, axis=1, edge_order=2)
        self.nz = n

    def _cell(self, z):
        t = (z - self.z0) / self.dz
        j = np.clip(np.floor(t).astype(np.int64), 0, self.nz - 2)
        return j, t - j

    def _hermite(self, F, S, ai, j, t):
        f0, f1 = F[ai, j], F[ai, j + 1]
        m0, m1 = S[ai, j] * self.dz, S[ai, j + 1] * self.dz
        t2 = t * t; t3 = t2 * t
        return (2 * t3 - 3 * t2 + 1) * f0 + (t3 - 2 * t2 + t) * m0 + (3 * t2 - 2 * t3) * f1 + (t3 - t2) * m1

    def value(self, ai, z):
        """Cubic Hermite interpolation using the exact first derivative."""
        j, t = self._cell(z)
        return self._hermite(self.f, self.d, ai, j, t)

    def deriv(self, ai, z, second=False):
        j, t = self._cell(z)
        g = self.d2 if second else self.d
        return (1 - t) * g[ai, j] + t * g[ai, j + 1]

    def scores(self, ai, z):
        """(d/dz, d/dtau) of log J, cubic Hermite with finite-difference slopes."""
        j, t = self._cell(z)
        return self._hermite(self.d, self.d2, ai, j, t), self._hermite(self.dt, self.dt2, ai, j, t)


# ---------------------------------------------------------- continuation block
class ContinuationData:
    """Parameter-free compression of (K, C, segment table) into patterns.

    Trees without later-post segments are grouped by (K, C); every other tree
    is its own pattern. `inverse` maps trees to patterns.
    """

    def __init__(self, K, C, seg_tree, seg_a, seg_cnt):
        K = np.asarray(K, np.int64); C = np.asarray(C, np.int64)
        n = len(K)
        has = np.zeros(n, bool)
        has[seg_tree] = True
        own = np.flatnonzero(has)
        plain = np.flatnonzero(~has)
        base = int(C.max()) + 1 if n else 1
        ukey, inv, cnt = np.unique(K[plain] * base + C[plain], return_inverse=True, return_counts=True)
        m0 = len(ukey)
        self.K = np.r_[ukey // base, K[own]].astype(float)
        self.C = np.r_[ukey % base, C[own]].astype(float)
        self.weight = np.r_[cnt, np.ones(len(own), np.int64)].astype(float)
        self.inverse = np.empty(n, np.int64)
        self.inverse[plain] = inv
        self.inverse[own] = m0 + np.arange(len(own))
        self.x = np.log(self.K)
        self.ep = self.inverse[seg_tree]
        self.a_values = np.unique(seg_a)
        self.ai = np.searchsorted(self.a_values, seg_a)
        self.ecnt = np.asarray(seg_cnt, float)
        self.n_patterns = len(self.K)
        self.n_trees = n


def continuation_loglik(cd, P, step=0.3, half_width=15.0, dz=0.01, span=20.0, gradient=False):
    """Per-pattern log E_theta[...] for the continuation block.

    step and half_width set the theta grid in units of each pattern's own
    posterior scale. (0.3, 15) is the reference setting; (0.6, 12) is about
    four times cheaper and adequate inside an optimizer.

    With gradient=True also returns the (n_patterns, 7) derivatives with
    respect to (c0, c1, s1, mu, gam, sig, tau): posterior means over theta of
    the score of the integrand (the grid placement needs no chain-rule term).
    """
    m = cd.n_patterns
    eta1 = P.c0 - P.c1 * cd.x
    zc = P.mu - P.gam * cd.x
    have = len(cd.ep) > 0
    if have:
        zz = zc[cd.ep]
        table = _JTable(cd.a_values, zz.min() - P.sig * span, zz.max() + P.sig * span, P.tau, dz)

    def parts(theta, order):
        y1 = eta1 + P.s1 * theta
        g = cd.C * _logsig(y1) + (cd.K - cd.C) * _log1msig(y1) - 0.5 * theta * theta
        g1 = g2 = None
        if order:
            u = expit(y1)
            g1 = P.s1 * (cd.C * (1 - u) - (cd.K - cd.C) * u) - theta
            g2 = -P.s1 ** 2 * cd.K * u * (1 - u) - 1.0
        if have:
            z = zc[cd.ep] + P.sig * theta[cd.ep]
            g = g + np.bincount(cd.ep, weights=cd.ecnt * table.value(cd.ai, z), minlength=m)
            if order:
                g1 = g1 + P.sig * np.bincount(cd.ep, weights=cd.ecnt * table.deriv(cd.ai, z), minlength=m)
                g2 = g2 + P.sig ** 2 * np.bincount(cd.ep, weights=cd.ecnt * table.deriv(cd.ai, z, True), minlength=m)
        return g, g1, g2

    warm = getattr(cd, "theta_mode", None)       # reuse the last modes inside an optimizer
    theta = np.zeros(m) if warm is None or len(warm) != m else warm.copy()
    lim = span - half_width - 0.5
    for _ in range(60):
        _, g1, g2 = parts(theta, 1)
        g2 = np.minimum(g2, -1e-6)
        delta = np.clip(-g1 / g2, -2.0, 2.0)
        theta = np.clip(theta + delta, -lim, lim)
        if np.max(np.abs(delta)) < 1e-10:
            break
    cd.theta_mode = theta.copy()
    _, _, g2 = parts(theta, 1)
    s = 1.0 / np.sqrt(-np.minimum(g2, -1e-6))
    nodes = _grid(step, half_width)
    if not gradient:
        acc = np.full(m, -np.inf)
        for xk in nodes:
            g, _, _ = parts(theta + s * xk, 0)
            acc = np.logaddexp(acc, g)
        return acc + np.log(step * s) - LOG_SQRT_2PI
    G = np.empty((len(nodes), m)); A1 = np.empty_like(G); BZ = np.zeros_like(G); BT = np.zeros_like(G)
    TH = np.empty_like(G)
    for i, xk in enumerate(nodes):
        th = theta + s * xk
        G[i], _, _ = parts(th, 0)
        u = expit(eta1 + P.s1 * th)
        A1[i] = cd.C * (1 - u) - (cd.K - cd.C) * u
        TH[i] = th
        if have:
            dz_, dt_ = table.scores(cd.ai, zc[cd.ep] + P.sig * th[cd.ep])
            BZ[i] = np.bincount(cd.ep, weights=cd.ecnt * dz_, minlength=m)
            BT[i] = np.bincount(cd.ep, weights=cd.ecnt * dt_, minlength=m)
    tot = logsumexp(G, axis=0)
    W = np.exp(G - tot)
    grad = np.empty((m, 7))
    e1, e1t = (W * A1).sum(0), (W * A1 * TH).sum(0)
    ez, ezt = (W * BZ).sum(0), (W * BZ * TH).sum(0)
    grad[:, 0] = e1; grad[:, 1] = -cd.x * e1; grad[:, 2] = e1t
    grad[:, 3] = ez; grad[:, 4] = -cd.x * ez; grad[:, 5] = ezt
    grad[:, 6] = (W * BT).sum(0)
    return tot + np.log(step * s) - LOG_SQRT_2PI, grad


# ------------------------------------------------------------------- end block
def branch_logpmf(d, alpha):
    """log[(d-1)^(-alpha) - d^(-alpha)], d >= 2 (floored Pareto)."""
    d = np.asarray(d, float)
    return -alpha * np.log(d - 1) + np.log(-np.expm1(-alpha * np.log1p(1.0 / (d - 1))))


class EndData:
    """Ending posts grouped by (role, K, degree) with counts."""

    def __init__(self, K_tree, end_tree, end_role, end_degree, end_cnt):
        K = np.asarray(K_tree, np.int64)[end_tree]
        role = np.asarray(end_role, np.int64) - 1
        D = np.asarray(end_degree, np.int64)
        bK, bD = int(K.max()) + 1, int(D.max()) + 1
        ukey, inv = np.unique((role * bK + K) * bD + D, return_inverse=True)
        self.cnt = np.bincount(inv, weights=np.asarray(end_cnt, float), minlength=len(ukey))
        self.D = ukey % bD
        self.K = ((ukey // bD) % bK).astype(float)
        self.role = (ukey // bD) // bK + 1


def _end_terms(role, K, D, P):
    """log-probability of each ending (leaf or branch of size D) given it ends."""
    x = np.log(K)
    b = np.where(role == 1, P.b1, P.b2)
    alpha = 1 + (P.alpha0 - 1) * np.exp(-b * x)
    kappa = expit(np.where(role == 1, P.g0, P.f0) + P.f1 * x)
    mean_branch = 1 + zeta(alpha, 1)
    if not np.all(np.isfinite(mean_branch)) or np.any(alpha <= 1):
        raise NumericalFailure("branch exponent is numerically 1: the branch mean is not finite")
    phi = kappa / mean_branch
    if np.any(phi <= 0) or np.any(phi >= 1):
        raise NumericalFailure("branch probability left (0, 1)")
    leaf = D == 0
    out = np.empty(len(D))
    out[leaf] = np.log1p(-phi[leaf])
    out[~leaf] = np.log(phi[~leaf]) + branch_logpmf(D[~leaf], alpha[~leaf])
    return out


def end_loglik(ed, P):
    """Total end-block log-likelihood from grouped counts."""
    return float(ed.cnt @ _end_terms(ed.role, ed.K, ed.D, P))


# ------------------------------------------------------------------ public API
class LogProbabilityParts(NamedTuple):
    root: float          # log p(K)
    conditional: float   # log p(tree | K), latent effects integrated out

    @property
    def total(self):
        return self.root + self.conditional


def batch_log_probability(stats, P, **kw):
    """Per-tree (root, continuation, end) log-probabilities for G18Stats."""
    cd = ContinuationData(stats.K, stats.C, stats.seg_tree, stats.seg_a, stats.seg_cnt)
    cont = continuation_loglik(cd, P, **kw)[cd.inverse]
    per_end = _end_terms(stats.end_role, stats.K[stats.end_tree].astype(float), stats.end_degree, P)
    end = np.bincount(stats.end_tree, weights=per_end * stats.end_cnt, minlength=stats.n_trees)
    return root_logpmf(stats.K, P), cont, end


def tree_log_probability_parts(parents, parameters, **kw):
    """LogProbabilityParts(root, conditional) for one tree given as a parent list."""
    offsets, flat = flatten([parents])
    root, cont, end = batch_log_probability(g18_stats(offsets, flat), parameters, **kw)
    return LogProbabilityParts(float(root[0]), float(cont[0] + end[0]))


def tree_log_probability(parents, parameters, **kw):
    """log p(K) + log p(tree | K) for one tree given as a parent list."""
    return tree_log_probability_parts(parents, parameters, **kw).total
