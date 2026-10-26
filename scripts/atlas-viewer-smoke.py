#!/usr/bin/env python3
"""Exercise source context and overlap focus on the real WebGL viewer."""

import json
import re
import subprocess
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = "http://127.0.0.1:4175"


def main() -> None:
    process = subprocess.Popen(
        [str(ROOT / "node_modules/.bin/vite"), "--host", "127.0.0.1", "--port", "4175", "--strictPort"],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(120):
            if process.poll() is not None:
                raise RuntimeError("Viewer test Vite server exited before becoming ready")
            try:
                with opener.open(URL, timeout=1):
                    break
            except OSError:
                time.sleep(0.25)
        else:
            raise RuntimeError("Viewer test Vite server did not become ready")

        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1000, "height": 800})
            page.route("**/__atlas-viewer-test__", lambda route: route.fulfill(
                content_type="text/html", body='<html><body style="margin:0"><canvas id="test-canvas" style="width:1000px;height:800px"></canvas></body></html>',
            ))
            page.goto(URL + "/__atlas-viewer-test__")
            with opener.open(URL + "/src/atlas/survey-layer-viewer.ts") as response:
                module = response.read().decode()
            three_url = re.search(r'import \* as THREE from "([^"]+)"', module).group(1)
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            result = page.evaluate("""async (threeUrl) => {
                const THREE = await import(threeUrl);
                // Observe the actual render scene without adding production test hooks.
                let scene;
                const add = THREE.Scene.prototype.add;
                THREE.Scene.prototype.add = function(...objects) {
                    scene ??= this;
                    return add.apply(this, objects);
                };
                const {SurveyLayerViewer} = await import('/src/atlas/survey-layer-viewer.ts');
                const surveys = [{id:'euclid',color:'#d95f59'},{id:'gaia',color:'#4f8fc8'}];
                const manifest = (order) => ({
                    schemaVersion:1, generatedAt:'2026-10-26T00:00:00Z', coordinateFrame:'ICRS', nside:2**order,
                    footprints:surveys.map((survey,index) => ({
                        surveyId:survey.id, releaseId:'fixture', product:'fixture', label:survey.id,
                        nside:2**order, pixels:[0,index+1], quality:'moc', sourceUrl:'https://example.org/',
                        retrievedAt:'2026-10-26T00:00:00Z', notes:'Synthetic browser fixture',
                    })),
                });
                const no = () => {};
                const events = [];
                const viewer = new SurveyLayerViewer(document.getElementById('test-canvas'),manifest(4),surveys,no,no,no,no,state=>events.push(state));
                const meshes = () => {
                    const result = {};
                    scene.traverse(object => {
                        if (object.isMesh && surveys.some(survey=>survey.id===object.userData.surveyId))
                            result[object.userData.surveyId] = object.userData.records.map(record=>record.pixel);
                    });
                    return result;
                };
                viewer.setVisibleSurveys(surveys.map(survey=>survey.id));
                viewer.setOverlapMode(true);
                viewer.setOverlapCoverage(16,[0],[{id:'C01',order:4,cells:[0]}]);
                const before = meshes();
                viewer.setOverlapCoverage(256,[0],[{id:'C01',order:8,cells:[0]}]);
                const after = meshes();
                viewer.setHomePresentation();
                const far = viewer.state.cameraDistance;
                viewer.focusSelection();
                await new Promise(resolve=>setTimeout(resolve,1000));
                const near = viewer.state.cameraDistance;
                events.length = 0;
                const components = [{id:'C01',order:8,cells:[0]},{id:'C02',order:8,cells:[8192]}];
                viewer.updateCoverage(manifest(8),surveys,['euclid','gaia'],{nside:256,pixels:[0,8192],components});
                const batch = {meshes:meshes(),nsides:events.map(state=>state.nside)};
                viewer.setActiveOverlapComponent('C02');
                viewer.setHomePresentation();
                viewer.focusSelection();
                await new Promise(resolve=>setTimeout(resolve,1000));
                const selectedDirection = viewer.state.coverageViewDirection;
                viewer.setHomePresentation();
                const predictedView = viewer.focusViewGeometry(256,[8192]);
                viewer.focusPixels(256,[8192]);
                await new Promise(resolve=>setTimeout(resolve,1000));
                const expectedDirection = viewer.state.coverageViewDirection;
                const actualViewRadius = viewer.state.coverageViewRadiusRad;
                viewer.setViewportRightInset(400);
                const insetPrediction = viewer.focusViewGeometry(256,[8192]);
                viewer.focusSelection();
                await new Promise(resolve=>setTimeout(resolve,1000));
                const insetViewRadius = viewer.state.coverageViewRadiusRad;
                viewer.setOverlapCoverage(256,[],[]);
                const empty = meshes();
                const emptyDistance = viewer.state.cameraDistance;
                viewer.focusSelection();
                await new Promise(resolve=>setTimeout(resolve,800));
                const emptyFocusDistance = viewer.state.cameraDistance;
                viewer.dispose();
                THREE.Scene.prototype.add = add;
                return {before,after,far,near,batch,selectedDirection,expectedDirection,predictedView,actualViewRadius,insetPrediction,insetViewRadius,empty,emptyDistance,emptyFocusDistance};
            }""", three_url)
            assert result["before"] == {"euclid": [0, 1], "gaia": [0, 2]}, result
            assert result["after"] == result["before"], "Changing overlap order must preserve non-overlap source context"
            assert result["near"] < result["far"] * 0.95, "F must advance toward the active overlap region without an ordinary cell selection"
            assert result["batch"] == {"meshes": result["before"], "nsides": [256]}, "Source context and overlap must commit at the same real order in one update"
            assert all(abs(a-b) < 1e-5 for a,b in zip(result["selectedDirection"],result["expectedDirection"])), "F must focus the selected component, including a component outside the source context cells"
            assert all(abs(a-b) < 1e-5 for a,b in zip(result["predictedView"]["coverageViewDirection"],result["expectedDirection"])) and abs(result["predictedView"]["coverageViewRadiusRad"] - result["actualViewRadius"]) < 1e-5, "Initial source loading must use the actual focused camera geometry"
            assert result["actualViewRadius"] < 0.2, "A close focus must load the small surface viewport rather than a distant-sky angular cone"
            assert result["insetViewRadius"] < result["actualViewRadius"], "The drawer's hidden canvas area must not enlarge the source viewport"
            assert abs(result["insetPrediction"]["coverageViewRadiusRad"] - result["insetViewRadius"]) < 1e-5, "Initial focus planning must also respect the drawer inset"
            assert result["empty"] == result["before"], "An empty intersection must not remove selected source context"
            assert abs(result["emptyDistance"] - result["emptyFocusDistance"]) < 1e-5, "F must not focus a stale component after the intersection becomes empty"
            assert not errors, errors
            print(json.dumps(result))
            browser.close()
    finally:
        process.terminate()
        process.wait(timeout=10)


if __name__ == "__main__":
    main()
