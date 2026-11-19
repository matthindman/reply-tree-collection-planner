"""Assemble the planner into one self-contained HTML file.

usage: python3 build.py
Writes planner.html (a page fragment for publishing as a Claude artifact) and index.html (the same page
with a full HTML skeleton, for GitHub Pages or opening from disk).
"""
import json
from pathlib import Path

here = Path(__file__).parent
src = lambda n: (here / "src" / n).read_text()
sim = src("sim.js")
head = """<title>Reply Tree Collection Planner</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
""" + src("style.css") + "</style>\n"
scripts = "\n".join(
    "<script>\n" + s + "\n</script>" for s in [
        src("ref_tables.js"), src("scenario_tables.js"), sim, src("cost.js"),
        "const SIM_SOURCE = " + json.dumps(sim).replace("</", "<\\/") + ";",
        src("app.js"),
    ])
fragment = head + src("page.html") + scripts + "\n"
(here / "planner.html").write_text(fragment)
(here / "index.html").write_text(
    "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    "<style>body{margin:0}[hidden]{display:none!important}</style>\n"
    + head + "</head>\n<body>\n" + src("page.html") + scripts + "\n</body>\n</html>\n")
print("planner.html", (here / "planner.html").stat().st_size, "bytes; index.html", (here / "index.html").stat().st_size, "bytes")
