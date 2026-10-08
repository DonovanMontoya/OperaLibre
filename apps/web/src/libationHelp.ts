export function libationHelp(detail: string): string {
  if (/already connected|already configured/i.test(detail)) {
    return "This account is already connected. Use Reconnect on its existing entry.";
  }
  if (/update libation|install libation to check/i.test(detail)) {
    return "Install or update Libation on the server to use browser sign-in. Existing Libation connections can still be used.";
  }
  if (/icu|invariant culture|globalization/i.test(detail)) {
    return "Libation needs the ICU system dependency. Run the OperaLibre installer with --libation on the server to check it.";
  }
  if (/insufficient free space|no space left|disk full|min_download_free_gib/i.test(detail)) {
    return "Free up space on the server's library drive, then retry. The download stopped to protect the storage reserve.";
  }
  if (/max_upload_gib|exceeds.*limit|over.*budget/i.test(detail)) {
    return "This book exceeds the server's import size limit, including temporary files. Adjust max_upload_gib on the server before retrying.";
  }
  if (/cannot find settings|AccountsSettings|Settings\.json|settings.*missing/i.test(detail)) {
    return "Check Libation's settings folder on the server. It must contain AccountsSettings.json and Settings.json. Update libation_files_dir and restart if needed.";
  }
  if (/not configured|CLI.*not found/i.test(detail)) {
    return "Set up Libation on the server with the OperaLibre installer's --libation option, then restart OperaLibre.";
  }
  if (/permission denied|access.*denied|read.only/i.test(detail)) {
    return "Check that OperaLibre can read Libation's settings and write to the library folder on the server, then retry.";
  }
  if (/busy|Libation is working|another.*job|current.*operation/i.test(detail)) {
    return "Libation is working on another operation. Wait for it to finish, then retry.";
  }
  if (/expired|cancelled|canceled/i.test(detail)) {
    return "The sign-in ended before it finished. Start a new sign-in when you're ready.";
  }
  if (/sign.in|signed in|log.?in|authentication|unauthorized|invalid.*token/i.test(detail)) {
    return "Reconnect this Audible account and try again. You can also sign in through Libation on the server.";
  }
  if (/timed? ?out|in time|did not respond|network|connection refused|fetch|unreachable/i.test(detail)) {
    return "Check that the server is online and can reach Audible, then retry. Check the account status before starting another sign-in.";
  }
  return "The operation could not finish. Check the account and setup status, then retry. Details are available below.";
}

export function validAudibleResponse(value: string): boolean {
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && /^(?:www\.)?(?:amazon|audible)\.(?:com|co\.uk|ca|de|fr|com\.au|co\.jp|in|es)$/i.test(url.hostname);
  } catch {
    return false;
  }
}
