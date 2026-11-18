import { type FormEvent, useState } from "react";
import { type Role, signIn } from "../api.ts";

/** The password screen for the hosted app: the admin password or the league mates' password. */
export function SignIn({ onSignedIn }: { onSignedIn: (role: Role) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await signIn(password));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Signing in failed.");
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <form className="card sign-in" onSubmit={(event) => void submit(event)}>
        <h1 className="sign-in-title">FantasyTool</h1>
        <p className="quiet">Enter the password you were given to see the league.</p>
        <label className="sign-in-field">
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
          />
        </label>
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button" disabled={busy || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
