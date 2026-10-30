#!/usr/bin/env python3
"""Generate the numerical model fixture; contains no observed survey data.

Requires astropy, numpy and scipy. Run from the repo root.
"""
import json
from pathlib import Path
import astropy
import numpy as np
from astropy.cosmology import Planck18

z = np.linspace(0, 2, 1025)
p = Planck18
reference = {
    "schemaVersion": 1, "model": "Astropy Planck18", "astropyVersion": astropy.__version__,
    "distanceKind": "line-of-sight-comoving", "unit": "Mpc", "H0_km_s_Mpc": p.H0.value,
    "Om0": p.Om0, "Ob0": p.Ob0, "Ode0": p.Ode0, "Tcmb0_K": p.Tcmb0.value,
    "Neff": p.Neff, "m_nu_eV": p.m_nu.value.tolist(),
    "reference": "https://docs.astropy.org/en/stable/api/astropy.cosmology.realizations.Planck18.html",
    "zStep": float(z[1]), "zMax": 2,
    "distanceMpc": np.round(p.comoving_distance(z).value, 8).tolist(),
    "referenceChecks": [{"z": v, "distanceMpc": float(p.comoving_distance(v).value)}
                        for v in [.001, .02, .1, .37, .5, 1, 1.5, 2]],
}
out = Path(__file__).resolve().parents[1] / "fixtures/distance-prototype/planck18-reference.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(reference, ensure_ascii=False, indent=2) + "\n")
print(out)
