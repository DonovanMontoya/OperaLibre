//! Setup checks and opt-in acquisition settings. Credentials stay in Libation.

use crate::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibationSetup {
    pub(crate) checks: Vec<LibationSetupCheck>,
    pub(crate) can_sign_in: bool,
    pub(crate) busy: bool,
}

#[derive(Serialize)]
pub(crate) struct LibationSetupCheck {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    pub(crate) ready: bool,
    pub(crate) message: String,
}

pub(crate) async fn libation_setup(
    State(state): State<AppState>,
    _: AdminUser,
) -> Result<Json<LibationSetup>, ApiError> {
    prune_expired_libation_login_sessions(&state).await;
    let guard = state.libation_job_lock.try_lock();
    let busy = guard.is_err();
    let installed = state.libation_config.enabled();
    let mut checks = vec![LibationSetupCheck {
        id: "installed",
        label: "Libation installed",
        ready: installed,
        message: if installed {
            "Libation was found on this server."
        } else {
            "Run the OperaLibre installer with --libation on the server, or set libation_cli_path and restart."
        }.to_string(),
    }];
    let (can_sign_in, message) = if busy {
        (
            false,
            "Libation is working. Check again when the current operation finishes.".to_string(),
        )
    } else if installed {
        match tokio::time::timeout(
            Duration::from_secs(5),
            run_libation(&state.libation_config, vec!["--help".to_string()]),
        )
        .await
        {
            Ok(Ok(output)) if output.status.success() => {
                let help = command_output_text(&output);
                let supported = help.contains("login-external") && help.contains("list-accounts");
                (supported, if supported { "This Libation supports browser sign-in." } else { "Update Libation for browser sign-in. Existing connections can still be used." }.to_string())
            }
            Ok(Ok(output)) => (
                false,
                sanitize_libation_login_output(&command_output_text(&output)),
            ),
            Ok(Err(error)) => (false, error.to_string()),
            Err(_) => (
                false,
                "Libation did not respond. Check its installation and system dependencies."
                    .to_string(),
            ),
        }
    } else {
        (
            false,
            "Install Libation to check browser sign-in support.".to_string(),
        )
    };
    checks.push(LibationSetupCheck {
        id: "sign_in",
        label: "Browser sign-in available",
        ready: can_sign_in,
        message,
    });
    if let Some(path) = &state.libation_config.libation_files_dir {
        let readable = ["AccountsSettings.json", "Settings.json"]
            .iter()
            .all(|name| {
                std::fs::read(path.join(name)).ok().is_some_and(|contents| {
                    serde_json::from_slice::<serde_json::Value>(&contents).is_ok()
                })
            });
        checks.push(LibationSetupCheck {
            id: "settings", label: "Existing Libation settings", ready: readable,
            message: if readable { "The existing settings folder is readable." } else { "Point libation_files_dir at the folder containing AccountsSettings.json and Settings.json, then restart." }.to_string(),
        });
    }
    let library_root = state.library_root.clone();
    let reserve = state.min_download_free_bytes;
    let storage = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let _probe = tempfile::Builder::new()
            .prefix(".operalibre-libation-check-")
            .tempfile_in(&library_root)?;
        Ok(fs2::available_space(&library_root)? > reserve.saturating_add(64 * 1024 * 1024))
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))?;
    checks.push(LibationSetupCheck {
        id: "storage",
        label: "Library storage",
        ready: matches!(storage, Ok(true)),
        message: match storage {
            Ok(true) => {
                "The library is writable and has space above the download reserve.".to_string()
            }
            Ok(false) => {
                "Free up space on the server's library drive before importing books.".to_string()
            }
            Err(error) => format!("Check the server's library permissions: {error}"),
        },
    });
    Ok(Json(LibationSetup {
        checks,
        can_sign_in,
        busy,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LibationAutoImportRequest {
    pub(crate) enabled: bool,
}

pub(crate) async fn set_libation_auto_import(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(profile_id): Path<String>,
    Json(payload): Json<LibationAutoImportRequest>,
) -> Result<Json<LibationStatus>, ApiError> {
    if auth.libation_access != LibationAccess::Direct {
        return Err(ApiError::forbidden(
            "Direct download permission is required to manage automatic imports.",
        ));
    }
    if !payload.enabled {
        state
            .libation_refreshes
            .mutate(|store| {
                store.auto_imports.remove(&profile_id);
                Ok(())
            })
            .await?;
        return Ok(Json(read_libation_status(&state).await));
    }
    let _guard = state.libation_job_lock.try_lock().map_err(|_| ApiError::conflict("Libation is busy. Try enabling automatic imports after the current operation finishes."))?;
    let profile = find_libation_profile(&state, &profile_id)
        .await
        .ok_or(ApiError::not_found("Audible account not found."))?;
    if profile.id == "legacy" {
        return Err(ApiError::bad_request(
            "Choose an individual Audible account.",
        ));
    }
    let mut books = export_libation_books(&profile).await?;
    let ownership = state
        .libation_refreshes
        .read()
        .await
        .legacy_ownership
        .clone();
    restore_legacy_ownership_books(&mut books, &ownership, &HashMap::new());
    let seen_asins = books
        .into_iter()
        .filter(|book| {
            book.profile_id == profile_id
                && !book.is_audible_plus
                && book
                    .content_type
                    .as_deref()
                    .is_none_or(|kind| kind.eq_ignore_ascii_case("Product"))
        })
        .map(|book| book.asin)
        .collect();
    state
        .libation_refreshes
        .mutate(|store| {
            // Repeated submissions must not advance the baseline past new purchases.
            store
                .auto_imports
                .entry(profile_id)
                .or_insert(LibationAutoImport {
                    enabled_by: auth.id,
                    seen_asins,
                });
            Ok(())
        })
        .await?;
    drop(_guard);
    Ok(Json(read_libation_status(&state).await))
}
