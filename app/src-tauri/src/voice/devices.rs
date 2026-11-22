//! Choosing audio devices (Settings > Speech): the list the user picks from, and the lookup that
//! opens the chosen one by the name cpal reports, or the default when it isn't there any more.

use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub name: String,
    pub is_default: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevices {
    pub inputs: Vec<DeviceInfo>,
    pub outputs: Vec<DeviceInfo>,
}

fn name_of(device: &cpal::Device) -> Option<String> {
    device.description().ok().map(|d| d.name().to_string())
}

/// Index of the device called `wanted`, if there is one. `None` for "system default" and for a
/// name that is gone, so the caller falls back to the default device.
pub fn position_of(names: &[String], wanted: Option<&str>) -> Option<usize> {
    let wanted = wanted.map(str::trim).filter(|w| !w.is_empty())?;
    names.iter().position(|n| n == wanted)
}

/// Names (no duplicates, in the order reported), each marked when it is the default.
fn infos(names: Vec<String>, default: Option<&str>) -> Vec<DeviceInfo> {
    let mut seen = Vec::<String>::new();
    for name in names {
        if !seen.contains(&name) {
            seen.push(name);
        }
    }
    seen.into_iter()
        .map(|name| DeviceInfo {
            is_default: default == Some(name.as_str()),
            name,
        })
        .collect()
}

pub fn list() -> AudioDevices {
    let host = cpal::default_host();
    let names = |devices: Result<Vec<cpal::Device>, _>| -> Vec<String> {
        devices
            .map(|d| d.iter().filter_map(name_of).collect())
            .unwrap_or_default()
    };
    let inputs = names(host.input_devices().map(Iterator::collect));
    let outputs = names(host.output_devices().map(Iterator::collect));
    let default_in = host.default_input_device().and_then(|d| name_of(&d));
    let default_out = host.default_output_device().and_then(|d| name_of(&d));
    AudioDevices {
        inputs: infos(inputs, default_in.as_deref()),
        outputs: infos(outputs, default_out.as_deref()),
    }
}

/// The input device called `wanted`, or the default one when `wanted` is `None` or missing.
pub fn input(host: &cpal::Host, wanted: Option<&str>) -> Option<cpal::Device> {
    if wanted.is_some() {
        if let Ok(devices) = host.input_devices() {
            let devices: Vec<cpal::Device> = devices.collect();
            let names: Vec<String> = devices
                .iter()
                .map(|d| name_of(d).unwrap_or_default())
                .collect();
            if let Some(i) = position_of(&names, wanted) {
                return devices.into_iter().nth(i);
            }
        }
    }
    host.default_input_device()
}

/// The output device called `wanted`, or the default one when `wanted` is `None` or missing.
pub fn output(host: &cpal::Host, wanted: Option<&str>) -> Option<cpal::Device> {
    if wanted.is_some() {
        if let Ok(devices) = host.output_devices() {
            let devices: Vec<cpal::Device> = devices.collect();
            let names: Vec<String> = devices
                .iter()
                .map(|d| name_of(d).unwrap_or_default())
                .collect();
            if let Some(i) = position_of(&names, wanted) {
                return devices.into_iter().nth(i);
            }
        }
    }
    host.default_output_device()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_named_device_is_found_exactly() {
        let all = names(&["Speakers", "USB Headset"]);
        assert_eq!(position_of(&all, Some("USB Headset")), Some(1));
        assert_eq!(position_of(&all, Some(" USB Headset ")), Some(1));
    }

    #[test]
    fn default_and_unplugged_devices_fall_back() {
        let all = names(&["Speakers", "USB Headset"]);
        assert_eq!(position_of(&all, None), None);
        assert_eq!(position_of(&all, Some("")), None);
        assert_eq!(position_of(&all, Some("Gone Mic")), None);
        assert_eq!(position_of(&[], Some("Speakers")), None);
    }

    #[test]
    fn listing_marks_the_default_and_drops_duplicates() {
        let out = infos(names(&["A", "B", "A"]), Some("B"));
        assert_eq!(
            out,
            vec![
                DeviceInfo {
                    name: "A".into(),
                    is_default: false
                },
                DeviceInfo {
                    name: "B".into(),
                    is_default: true
                },
            ]
        );
    }
}
