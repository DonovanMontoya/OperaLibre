import { useState } from "react";
import {
  activateServerAlias,
  addServerAlias,
  getServerAliases,
  hasSignInAt,
  signInAtAddress,
  type ServerAlias
} from "./api";

export function useServerAliases() {
  const [serverAliases, setServerAliases] = useState<ServerAlias[]>(getServerAliases);
  const [aliasName, setAliasName] = useState("");
  const [aliasUrl, setAliasUrl] = useState("");
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [switchingAliasId, setSwitchingAliasId] = useState<string | null>(null);
  // The address waiting for its own sign-in before it can be used.
  const [signInAliasId, setSignInAliasId] = useState<string | null>(null);
  const [aliasPassword, setAliasPassword] = useState("");

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

  async function activate(alias: ServerAlias, signIn?: { username: string; password: string }) {
    setAliasError(null);
    setSwitchingAliasId(alias.id);
    try {
      if (signIn) {
        await signInAtAddress(alias.url, signIn.username, signIn.password);
      }
      await activateServerAlias(alias);
      window.location.reload();
    } catch (error) {
      setAliasError(error instanceof Error ? error.message : "Could not reach that address.");
      setSwitchingAliasId(null);
    }
  }

  async function switchToAlias(alias: ServerAlias) {
    if (!hasSignInAt(alias.url)) {
      setAliasError(null);
      setAliasPassword("");
      setSignInAliasId(alias.id);
      return;
    }
    await activate(alias);
  }

  async function signInToAlias(event: React.FormEvent, alias: ServerAlias, username: string) {
    event.preventDefault();
    const password = aliasPassword;
    setAliasPassword("");
    await activate(alias, { username, password });
  }

  return {
    aliasError,
    aliasName,
    aliasPassword,
    aliasUrl,
    saveAlias,
    serverAliases,
    setAliasName,
    setAliasPassword,
    setAliasUrl,
    setServerAliases,
    setSignInAliasId,
    signInAliasId,
    signInToAlias,
    switchToAlias,
    switchingAliasId
  };
}
