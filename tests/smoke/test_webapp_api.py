import asyncio
import re

import pytest

from webapp.backend import main


class JsonRequest:
    def __init__(self, payload):
        self.payload = payload

    async def json(self):
        return self.payload


@pytest.mark.smoke
def test_start_experiment_uses_default_config(monkeypatch):
    calls = {}

    class FakeProcess:
        pid = 12345

    def fake_popen(command, **kwargs):
        calls["command"] = command
        calls["kwargs"] = kwargs
        return FakeProcess()

    class FakeValidator:
        def __init__(self, path):
            calls["validated_path"] = path

        def validate(self):
            return {}

    monkeypatch.setattr(main.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(main, "ConfigValidator", FakeValidator)

    response = asyncio.run(main.start_experiment(JsonRequest({
        "counties": ["27003"],
        "matsim": {"configurable_params": {"lastIteration": 1}},
    })))

    assert response == {
        "status": "started",
        "pid": 12345,
        "config": str(calls["validated_path"].relative_to(main.PROJECT_ROOT)),
        "experiment_id": calls["validated_path"].parent.name,
    }
    assert re.fullmatch(r"web_experiment_\d{8}_\d{6}", response["experiment_id"])
    assert calls["command"] == [
        main.sys.executable,
        str(main.EXPERIMENT_RUNNER_PATH),
        "--config",
        str(calls["validated_path"]),
        "--experiment-id",
        calls["validated_path"].parent.name,
    ]
    assert calls["validated_path"].exists()
    assert calls["kwargs"]["cwd"] == main.PROJECT_ROOT
    assert calls["kwargs"]["stdin"] is main.subprocess.DEVNULL
    assert calls["kwargs"]["stdout"] is main.subprocess.DEVNULL
    assert calls["kwargs"]["stderr"] is main.subprocess.DEVNULL

    experiment_dir = calls["validated_path"].parent
    calls["validated_path"].unlink()
    experiment_dir.rmdir()


@pytest.mark.smoke
def test_build_experiment_config_retains_survey_metadata():
    config = main.build_experiment_config({
        "surveys": [{
            "type": "nhts",
            "year": "2022",
            "file": "nhts/csv/tripv2pub.csv",
            "weight": 1,
        }],
    })

    surveys = config["data"]["surveys"]
    assert surveys[0]["person_file"] == "nhts/csv/perv2pub.csv"
