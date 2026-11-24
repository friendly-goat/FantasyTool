import { useEffect, useRef } from "react";
import type { StrengthModel, TeamStrength } from "../../shared/strength.ts";
import type { LeagueSnapshot, PlayerStats, StatsReport } from "../../shared/types.ts";
import { closeDialog, openDialog } from "../closeDialog.ts";
import { useBackToClose, useSheetPull } from "../sheetGestures.ts";
import { formatPoints, formatRecord } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { TeamCharts, useProfiles } from "./TeamCharts.tsx";
import { TeamRoster } from "./Teams.tsx";

interface Props {
  /** The latest league, for the roster. */
  snapshot: LeagueSnapshot;
  /** The snapshot the model was built from, for the charts (as on My team and Teams). */
  modelSnapshot: LeagueSnapshot;
  model: StrengthModel | null;
  strengths: TeamStrength[] | null;
  stats: StatsReport | null;
  rosterId: number;
  myRosterId: number | null;
  onClose: () => void;
}

const NO_PLAYERS: Record<string, PlayerStats> = {};

/**
 * One fantasy team's card, opened from its name (the trade ideas and the trade
 * builder): who it is, its charts and its roster, over the page like a
 * player's details (a bottom sheet on a phone). Just the one team: moving
 * between teams is the Teams tab's job.
 */
export function TeamPanel({ snapshot, modelSnapshot, model, strengths, stats, rosterId, myRosterId, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  // On a phone: pull down from the top to close; Back closes the card instead of leaving the page.
  useSheetPull(dialog);
  useBackToClose(true, () => closeDialog(dialog.current));
  const players = stats?.players ?? NO_PLAYERS;
  // The same profiles as My team and Teams (worked out once per model).
  const profiles = useProfiles(modelSnapshot, model, strengths, players, stats?.allowed);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) openDialog(element);
  }, []);

  const team = snapshot.teams.find((candidate) => candidate.rosterId === rosterId);
  if (!team) return null;

  return (
    <dialog
      ref={dialog}
      className="player-panel team-panel"
      aria-labelledby="team-panel-name"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        closeDialog(dialog.current);
      }}
      onClick={(event) => {
        if (event.target === dialog.current) closeDialog(dialog.current);
      }}
    >
      <div className="sheet-grabber panel-grabber" aria-hidden="true" />
      <div className="panel-close">
        <button type="button" className="button button-plain panel-close-button" onClick={() => closeDialog(dialog.current)}>
          Close
        </button>
      </div>
      <div className="panel-body">
        <div className="panel-head">
          <div className="team-cell">
            <Avatar url={team.avatarUrl} name={team.teamName} size="lg" />
            <div>
              <h2 id="team-panel-name" className="team-title">
                {team.teamName}
              </h2>
              <p className="quiet">
                {team.managerName}, {formatRecord(team.wins, team.losses, team.ties)}, {formatPoints(team.pointsFor)} points
                scored
              </p>
            </div>
          </div>
        </div>

        <TeamCharts snapshot={modelSnapshot} profile={profiles?.get(team.rosterId) ?? null} own={team.rosterId === myRosterId} />

        <div className="team-panel-roster">
          <TeamRoster team={team} stats={stats} />
        </div>
      </div>
    </dialog>
  );
}
