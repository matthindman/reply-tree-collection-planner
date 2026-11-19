"""Slow, independent reference likelihoods for small trees (tests only).

g18_reference integrates on fixed fine grids with the trapezoid rule and uses
the naive per-post statistics. It shares no numerical code with g18.py.
"""

import numpy as np
from scipy.special import zeta

from .data import naive_stats
from .g18 import root_logpmf   # the root term is closed form; reused deliberately


def _sig(y):
    return 1.0 / (1.0 + np.exp(-y))


def g18_reference(parents, P, n=2401, span=12.0):
    st = naive_stats(parents)
    K, C = st["K"], st["C"]
    x = np.log(K)
    theta = np.linspace(-span, span, n)
    eps = np.linspace(-span, span, n)
    h = theta[1] - theta[0]
    wts = np.full(n, h); wts[0] = wts[-1] = h / 2
    dens = np.exp(-0.5 * eps * eps) / np.sqrt(2 * np.pi)
    u1 = _sig(P.c0 - P.c1 * x + P.s1 * theta)
    integrand = u1 ** C * (1 - u1) ** (K - C)
    z = P.mu - P.gam * x + P.sig * theta
    cache = {}
    for a in st["seg_a"]:
        if a not in cache:
            L = _sig(z[:, None] + P.tau * eps[None, :])
            cache[a] = (L ** a * (1 - L)) @ (dens * wts)
        integrand = integrand * cache[a]
    cont = np.log(np.sum(integrand * dens * wts))
    end = 0.0
    for role, D in st["ends"]:
        b = P.b1 if role == 1 else P.b2
        alpha = 1 + (P.alpha0 - 1) * K ** (-b)
        kappa = _sig((P.g0 if role == 1 else P.f0) + P.f1 * x)
        phi = kappa / (1 + zeta(alpha, 1))
        if D == 0:
            end += np.log(1 - phi)
        else:
            end += np.log(phi) + np.log((D - 1.0) ** (-alpha) - float(D) ** (-alpha))
    return float(root_logpmf(K, P)), float(cont + end)
