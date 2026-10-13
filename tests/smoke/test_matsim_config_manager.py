import xml.etree.ElementTree as ET

import pytest

from matsim.config_manager import ConfigManager


@pytest.mark.smoke
def test_config_manager_declares_enabled_bike_mode():
    manager = ConfigManager({
        "modes": {
            "car": {"enabled": True, "matsim_mode": "car"},
            "bike": {"enabled": True, "matsim_mode": "bike"},
        },
    })
    tree = ET.fromstring(
        """
        <config>
          <module name="scoring">
            <parameterset type="scoringParameters">
              <parameterset type="modeParams">
                <param name="mode" value="car"/>
              </parameterset>
            </parameterset>
          </module>
        </config>
        """
    )

    manager.ensure_mode_params(ET.ElementTree(tree))

    modes = {
        mode_params.find("param[@name='mode']").get("value")
        for mode_params in tree.findall(
            "./module[@name='scoring']/parameterset[@type='scoringParameters']/"
            "parameterset[@type='modeParams']"
        )
    }
    assert modes == {"car", "bike"}
