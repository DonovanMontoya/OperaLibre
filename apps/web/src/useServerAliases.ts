import { useState } from "react";
import {
  activateServerAlias,
  addServerAlias,
  getServerAliases,
  getServerType,
  pingServer,
  type ServerAlias
} from "./api";

export function useServerAliases() {
  const [serverAliases, setServerAliases] = useState<ServerAlias[]>(getServerAliases);
  const [aliasName, setAliasName] = useState("");
  const [aliasUrl, setAliasUrl] = useState("");
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [switchingAliasId, setSwitchingAliasId] = useState<string | null>(null);

  function saveAlias(event: React.FormEvent) {
    event.preventDefault();
    setAliasError(null);
    try {
      addServerAlias(aliasName, aliasUrl);
      setServerAliases(getServerAliases());
      setAliasName("");
      setAliasUrl("");
    } catch (error) {
      setAliasError(error instanceof Error ? error.message : "Could not save that alias.");
    }
  }

  async function switchToAlias(alias: ServerAlias) {
    setAliasError(null);
    setSwitchingAliasId(alias.id);
    try {
      await pingServer(getServerType(), alias.url);
      activateServerAlias(alias);
      window.location.reload();
    } catch (error) {
      setAliasError(error instanceof Error ? error.message : "Could not reach that address.");
      setSwitchingAliasId(null);
    }
  }

  return {
    aliasError,
    aliasName,
    aliasUrl,
    saveAlias,
    serverAliases,
    setAliasName,
    setAliasUrl,
    setServerAliases,
    switchToAlias,
    switchingAliasId
  };
}
