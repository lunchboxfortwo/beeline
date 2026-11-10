use std::{ffi::OsString, path::Path};

/// Strip only AppImage-owned paths from the external application's environment.
/// WebKit and Beeline keep their bundled libraries; host launchers and browsers
/// must load their own. Preserve the person's remaining paths and session vars.
pub fn browser_environment(
    environment: impl IntoIterator<Item = (OsString, OsString)>,
    appdir: &Path,
) -> Vec<(OsString, Option<OsString>)> {
    const PATH_VARIABLES: &[&str] = &[
        "PATH",
        "LD_LIBRARY_PATH",
        "PYTHONPATH",
        "QT_PLUGIN_PATH",
        "XDG_DATA_DIRS",
        "GST_PLUGIN_SYSTEM_PATH",
        "GST_PLUGIN_SYSTEM_PATH_1_0",
        "GTK_DATA_PREFIX",
        "GSETTINGS_SCHEMA_DIR",
        "GI_TYPELIB_PATH",
        "GTK_EXE_PREFIX",
        "GTK_PATH",
        "GTK_IM_MODULE_FILE",
        "GDK_PIXBUF_MODULE_FILE",
        "GIO_EXTRA_MODULES",
    ];
    environment
        .into_iter()
        .filter_map(|(key, value)| {
            if ["APPDIR", "APPIMAGE", "ARGV0"]
                .iter()
                .any(|name| key == *name)
            {
                return Some((key, None));
            }
            if !PATH_VARIABLES.iter().any(|name| key == *name) {
                return None;
            }
            let paths: Vec<_> = std::env::split_paths(&value).collect();
            let retained: Vec<_> = paths
                .iter()
                .filter(|path| !path.starts_with(appdir))
                .collect();
            if retained.len() == paths.len() {
                return None;
            }
            let value = if retained.is_empty() {
                None
            } else {
                Some(
                    std::env::join_paths(retained)
                        .expect("existing environment paths remain valid"),
                )
            };
            Some((key, value))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn changes(values: &[(&str, &str)]) -> Vec<(OsString, Option<OsString>)> {
        browser_environment(
            values.iter().map(|(k, v)| ((*k).into(), (*v).into())),
            Path::new("/image"),
        )
    }

    #[test]
    fn removes_bundle_paths_and_keeps_host_paths_in_order() {
        assert_eq!(
            changes(&[
                ("PATH", "/image/usr/bin:/usr/local/bin:/usr/bin"),
                ("LD_LIBRARY_PATH", "/image/usr/lib/:/image//lib:/custom/lib"),
                (
                    "XDG_DATA_DIRS",
                    "/image/usr/share:/usr/share:/home/person/share"
                ),
            ]),
            vec![
                ("PATH".into(), Some("/usr/local/bin:/usr/bin".into())),
                ("LD_LIBRARY_PATH".into(), Some("/custom/lib".into())),
                (
                    "XDG_DATA_DIRS".into(),
                    Some("/usr/share:/home/person/share".into())
                ),
            ]
        );
    }

    #[test]
    fn unsets_bundle_only_paths_and_appimage_identity() {
        for key in [
            "GTK_PATH",
            "GIO_EXTRA_MODULES",
            "GSETTINGS_SCHEMA_DIR",
            "GI_TYPELIB_PATH",
        ] {
            assert_eq!(
                changes(&[(key, "/image/usr/lib")]),
                vec![(key.into(), None)]
            );
        }
        assert_eq!(
            changes(&[
                ("APPDIR", "/image"),
                ("APPIMAGE", "/apps/Beeline.AppImage"),
                ("ARGV0", "Beeline")
            ]),
            vec![
                ("APPDIR".into(), None),
                ("APPIMAGE".into(), None),
                ("ARGV0".into(), None)
            ]
        );
    }

    #[test]
    fn preserves_host_session_and_similarly_named_directories() {
        assert!(changes(&[
            ("DISPLAY", ":1"),
            ("WAYLAND_DISPLAY", "wayland-0"),
            ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
            ("BROWSER", "/usr/bin/firefox"),
            ("HOME", "/home/person"),
            ("LD_LIBRARY_PATH", "/image-other/lib:/custom/lib"),
            ("GTK_PATH", "/custom/gtk"),
        ])
        .is_empty());
    }
}
