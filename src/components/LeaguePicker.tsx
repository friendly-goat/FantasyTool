import { useState, type FormEvent } from "react";
import type { UserLeagues } from "../../shared/types.ts";
import { getUserLeagues } from "../api.ts";

export function LeaguePicker({ onOpen }: { onOpen: (leagueId: string) => void }) {
  const [username, setUsername] = useState("");
  const [leagueId, setLeagueId] = useState("");
  const [result, setResult] = useState<UserLeagues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  async function findLeagues(event: FormEvent) {
    event.preventDefault();
    if (!username.trim()) return;
    setSearching(true);
    setError(null);
    setResult(null);
    try {
      setResult(await getUserLeagues(username.trim()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The search failed.");
    } finally {
      setSearching(false);
    }
  }

  function openById(event: FormEvent) {
    event.preventDefault();
    if (leagueId.trim()) onOpen(leagueId.trim());
  }

  return (
    <section className="picker">
      <h1 className="league-name">Open your league</h1>
      <p className="quiet">
        League data is read from Sleeper's public API. Nothing is changed in your league.
      </p>

      <form className="picker-form" onSubmit={findLeagues}>
        <label htmlFor="username">Sleeper username</label>
        <div className="field-row">
          <input
            id="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="button" disabled={searching}>
            {searching ? "Searching…" : "Find leagues"}
          </button>
        </div>
      </form>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      {result && result.leagues.length === 0 && (
        <p className="notice">
          {result.user.displayName} has no NBA leagues in the {result.season} season. If the league
          is from another season, open it by ID below.
        </p>
      )}

      {result && result.leagues.length > 0 && (
        <ul className="league-list">
          {result.leagues.map((league) => (
            <li key={league.id}>
              <button type="button" className="league-option" onClick={() => onOpen(league.id)}>
                <span className="league-option-name">{league.name}</span>
                <span className="quiet">
                  {league.totalRosters} teams, {league.season}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="picker-form" onSubmit={openById}>
        <label htmlFor="league-id">Or enter a league ID</label>
        <div className="field-row">
          <input
            id="league-id"
            value={leagueId}
            onChange={(event) => setLeagueId(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
          />
          <button type="submit" className="button button-plain">
            Open league
          </button>
        </div>
        <p className="quiet hint">
          The ID is the long number in the league's address on sleeper.com.
        </p>
      </form>
    </section>
  );
}
