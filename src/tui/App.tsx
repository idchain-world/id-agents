import { readFileSync } from 'node:fs';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { Footer } from './components/Footer.js';
import { HelpView, HELP_VIEW_CHROME_ROWS } from './components/HelpView.js';
import { TeamsPanel } from './components/TeamsPanel.js';
import { AgentsTable } from './components/AgentsTable.js';
import { NewsView } from './components/NewsView.js';
import { NewsDetail } from './components/NewsDetail.js';
import { StatusStrip } from './components/StatusStrip.js';
import { TasksTable } from './components/TasksTable.js';
import { TaskDetail } from './components/TaskDetail.js';
import { CalendarView } from './components/CalendarView.js';
import { HeartbeatsView, type HeartbeatRow } from './components/HeartbeatsView.js';
import { HeartbeatDetail } from './components/HeartbeatDetail.js';
import { AgentDetail } from './components/AgentDetail.js';
import { LibraryAgentsTable } from './components/LibraryAgentsTable.js';
import { LibraryAgentDetail } from './components/LibraryAgentDetail.js';
import { LibrarySkillsTable } from './components/LibrarySkillsTable.js';
import { LibrarySkillDetail } from './components/LibrarySkillDetail.js';
import { LibraryTeamsTable } from './components/LibraryTeamsTable.js';
import { LibraryTeamDetail, type InstallState as LibraryTeamInstallState } from './components/LibraryTeamDetail.js';
import { ConfigsList } from './components/ConfigsList.js';
import { ConfigDetail } from './components/ConfigDetail.js';
import { OutputList } from './components/OutputList.js';
import { OutputDetail } from './components/OutputDetail.js';
import { CommandBar } from './components/CommandBar.js';
import { CommandResultView } from './components/CommandResultView.js';
import { CommandResultTable } from './components/CommandResultTable.js';
import {
  commandConfirmPreview,
  completeBuffer,
  confirmationLevel,
  knownCommandNames,
  lookupCommand,
  parseCommandLine,
} from './commands/registry.js';
import { ManagerError, NetworkError } from './api/manager.js';
import type { Agent, NewsItem, Schedule, Task, Team } from './api/types.js';
import {
  fetchAgentNews,
  fetchAgentsAllTeams,
  fetchAgentsLatestNewsTs,
  fetchLibraryAgent,
  fetchLibraryAgents,
  fetchLibrarySkill,
  fetchLibrarySkills,
  fetchLibraryTeam,
  fetchLibraryTeams,
  installLibraryTeam,
  fetchSchedulesAllTeams,
  fetchTasksAllTeams,
  fetchTeams,
  getManagerUrl,
  type LibraryAgentDetailResponse,
  type LibraryAgentListResponse,
  type LibrarySkillDetailResponse,
  type LibrarySkillListResponse,
  type LibraryTeamDetailResponse,
  type LibraryTeamListResponse,
} from './api/manager.js';
import { usePolling } from './hooks/usePolling.js';
import { humanizeUptime } from './util/format.js';
import { newsAgeColor } from './util/colors.js';
import {
  orderTeams,
  filterAgentsByTeam,
  computeTeamCounts,
  countByTeam,
  localAgentIds as selectLocalAgentIds,
  filterTasksByTeam,
  sortNewsByTimestamp,
  filterCalendarSchedules,
  clampScroll,
} from '../dashboard-core/selectors/index.js';
import {
  fetchRssForPids,
  formatTotalMemory,
  totalMemoryColor as totalMemColor,
} from './util/memory.js';
import { detectTabularResult, type TabularDetection } from './util/tabular.js';
import { copyToClipboard } from './util/clipboard.js';
import { listConfigFiles } from './util/configs.js';
import { listOutputFiles, readOutputFileDetail } from './util/output-files.js';
import type { CommandResultRenderer } from './commands/registry.js';

type View =
  | 'agents'
  | 'agent-detail'
  | 'news'
  | 'news-detail'
  | 'tasks'
  | 'task-detail'
  | 'calendar'
  | 'heartbeats'
  | 'heartbeat-detail'
  | 'library-agents'
  | 'library-agent-detail'
  | 'library-skills'
  | 'library-skill-detail'
  | 'library-teams'
  | 'library-team-detail'
  | 'configs-list'
  | 'config-detail'
  | 'output-list'
  | 'output-detail';

const AGENTS_POLL_MS = 2000;
const TEAMS_POLL_MS = 15000;
const NEWS_POLL_MS = 3000;
const TASKS_POLL_MS = 5000;
const SCHEDULES_POLL_MS = 5000;
const LIBRARY_POLL_MS = 5000;
const NEWS_COOLDOWN_TICK_MS = 10_000;
const AGENTS_CHROME_ROWS = 11;
const NEWS_CHROME_ROWS = 6;
const DETAIL_CHROME_ROWS = 6;
const TASKS_CHROME_ROWS = 10;
// Calendar: no TeamsPanel, no StatusStrip — only the bordered list box
// (border 2 + title 1 + header 1 + above-arrow 1 + body windowSize +
// below-arrow 1 = windowSize + 6) and the footer (1). Off-by-one here
// causes the list to overflow the terminal height and the terminal to
// scroll up on every redraw, leaking the previous frame's chrome.
const CALENDAR_CHROME_ROWS = 7;
// Heartbeats: no TeamsPanel, no StatusStrip — bordered list box
// (windowSize + 6) + footer (1) = 7. Matches Calendar.
const HEARTBEATS_CHROME_ROWS = 7;
// Library tables include a one-line subtitle (the libraryRoot path) on top
// of the standard list-box chrome, so they need 1 extra row vs Heartbeats.
const LIBRARY_CHROME_ROWS = 8;
const DETAIL_CONTENT_WIDTH = 76;
const MIN_VISIBLE = 3;
const SELF_AGENT = 'tui';
const FLASH_MS = 1500;
const TERMINAL_CONTENT_WIDTH = 76;
// 'sync' removed in commit 9 (D2) — it mutates nothing now, so it must not
// trigger the team-mutation refresh path.
const TEAM_MUTATING_COMMANDS: ReadonlySet<string> = new Set(['team', 'deploy']);
// Commands whose first positional arg is an agent name. When the operator
// is on the All view (selectedTeam === null), App.tsx tries to resolve
// the agent across all teams to pick the right X-Id-Team header.
const AGENT_TARGETED_COMMANDS: ReadonlySet<string> = new Set([
  'meta', 'output', 'cancel', 'delete',
  'ask', 'hey', 'agent',
]);
const NEWS_MESSAGE_WIDTH = TERMINAL_CONTENT_WIDTH - 8 - 1 - 17 - 4;

interface AppProps {
  staticMode?: boolean;
}

interface CommandResultState {
  command: string;
  text: string;
  renderer: CommandResultRenderer;
  table: TabularDetection | null;
  tableError: string | null;
  showJson: boolean;
}

export interface CommandResultInputKey {
  escape?: boolean;
  ctrl?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  return?: boolean;
}

export function commandResultConsumesInput(
  input: string,
  key: CommandResultInputKey,
  { canShowJson }: { canShowJson: boolean },
): boolean {
  return Boolean(
    key.escape ||
      key.leftArrow ||
      key.return ||
      input === ':' ||
      input === '/' ||
      (key.ctrl && input === 'c') ||
      input === 'q' ||
      input === '?' ||
      (input === 'j' && canShowJson) ||
      key.upArrow ||
      key.downArrow ||
      key.rightArrow ||
      key.pageUp ||
      key.pageDown,
  );
}

function previewJson(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 200);
}

export function helpWindowSizeForRows(rows: number): number {
  return Math.max(MIN_VISIBLE, rows - HELP_VIEW_CHROME_ROWS);
}

export function App({ staticMode = false }: AppProps = {}): React.ReactElement {
  const manager = useMemo(getManagerUrl, []);
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [staticTeams, setStaticTeams] = useState<Team[] | null>(null);
  const [staticAllAgents, setStaticAllAgents] = useState<Agent[] | null>(null);
  const [teamsRefreshKey, setTeamsRefreshKey] = useState(0);

  useEffect(() => {
    if (!staticMode) return;
    const ac = new AbortController();
    void (async () => {
      try {
        const ts = await fetchTeams(manager, ac.signal);
        const ags = await fetchAgentsAllTeams(manager, ts, ac.signal);
        if (!ac.signal.aborted) {
          setStaticTeams(ts);
          setStaticAllAgents(ags);
        }
      } catch {
        /* swallow — diagnostic */
      }
    })();
    return () => ac.abort();
  }, [staticMode, manager]);

  const [view, setView] = useState<View>('agents');
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [windowStart, setWindowStart] = useState(0);
  const [newsSelectedIndex, setNewsSelectedIndex] = useState(0);
  const [newsWindowStart, setNewsWindowStart] = useState(0);
  const [taskSelectedIndex, setTaskSelectedIndex] = useState(0);
  const [taskWindowStart, setTaskWindowStart] = useState(0);
  const [schedSelectedIndex, setSchedSelectedIndex] = useState(0);
  const [schedWindowStart, setSchedWindowStart] = useState(0);
  const [hbSelectedIndex, setHbSelectedIndex] = useState(0);
  const [hbWindowStart, setHbWindowStart] = useState(0);
  const [libAgentSelectedIndex, setLibAgentSelectedIndex] = useState(0);
  const [libAgentWindowStart, setLibAgentWindowStart] = useState(0);
  const [libSkillSelectedIndex, setLibSkillSelectedIndex] = useState(0);
  const [libSkillWindowStart, setLibSkillWindowStart] = useState(0);
  const [libAgentDetailScroll, setLibAgentDetailScroll] = useState(0);
  const [libSkillDetailScroll, setLibSkillDetailScroll] = useState(0);
  // Slice 4 — teams library + install flow. The detail view holds an
  // ephemeral InstallState that walks from idle → prompt → running →
  // success/error; the prompt buffer (`dest`) is edited in-place by the
  // input handler below.
  const [libTeamSelectedIndex, setLibTeamSelectedIndex] = useState(0);
  const [libTeamWindowStart, setLibTeamWindowStart] = useState(0);
  const [libTeamDetailScroll, setLibTeamDetailScroll] = useState(0);
  const [libTeamInstallState, setLibTeamInstallState] = useState<LibraryTeamInstallState>({ kind: 'idle' });
  const [configSelectedIndex, setConfigSelectedIndex] = useState(0);
  const [configWindowStart, setConfigWindowStart] = useState(0);
  const [configDetailScroll, setConfigDetailScroll] = useState(0);
  const [configRefreshKey, setConfigRefreshKey] = useState(0);
  const [outputAgentName, setOutputAgentName] = useState<string | null>(null);
  const [outputTeamName, setOutputTeamName] = useState<string | null>(null);
  const [outputSelectedIndex, setOutputSelectedIndex] = useState(0);
  const [outputWindowStart, setOutputWindowStart] = useState(0);
  const [outputDetailScroll, setOutputDetailScroll] = useState(0);
  const [outputRefreshKey, setOutputRefreshKey] = useState(0);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [helpScroll, setHelpScroll] = useState(0);
  const [cooldownEpoch, setCooldownEpoch] = useState<number>(() => Date.now());

  // ── Command bar state (Phase 1) ────────────────────────────────────
  // commandMode: bar is visible, keystrokes go into commandBuffer.
  // commandResult: a previous command's output is rendered in the main
  //   slot in place of the active view; Esc clears it.
  // commandError: inline single-line error rendered above the bar.
  const [commandMode, setCommandMode] = useState(false);
  const [commandBuffer, setCommandBuffer] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [commandHistoryIndex, setCommandHistoryIndex] = useState<number | null>(null);
  const [commandResult, setCommandResult] = useState<CommandResultState | null>(null);
  const [commandResultScroll, setCommandResultScroll] = useState(0);
  // Transient one-line confirmation (e.g. "copied: <path>"). Auto-clears
  // after FLASH_MS so it doesn't linger.
  const [flashMessage, setFlashMessage] = useState<string | null>(null);
  // Phase 6: error kind drives the visual treatment. 'network' renders
  // yellow with a connectivity glyph (transient — try again later);
  // 'manager' renders red (semantic — server understood and rejected).
  const [commandError, setCommandError] = useState<{ kind: 'network' | 'manager'; message: string } | null>(null);
  const [commandRunning, setCommandRunning] = useState(false);
  // commandPending: a Y/N-gated command is staged. Y dispatches it,
  // N or Esc discards. Holds the raw line + preview line for rendering.
  const [commandPending, setCommandPending] = useState<{ raw: string; preview: string } | null>(null);
  // commandRetype (Phase 4): a retype-gated command is staged. The
  // user must type the exact raw line back before Enter dispatches.
  // mismatchSeen drives the inline error after the first wrong submit.
  const [commandRetype, setCommandRetype] = useState<{
    expected: string;
    preview: string;
    typed: string;
    mismatchSeen: boolean;
  } | null>(null);
  const backgroundPaused = showHelp || showQuitConfirm;

  // Cooldown tick runs on news AND agents so the news-freshness dot in
  // the agents table colours against the same 10s epoch rather than a
  // free-running clock. Bucketed colour thresholds mean re-renders only
  // fire when an item crosses a 60/300/900s band.
  useEffect(() => {
    const needsTick = !backgroundPaused && (view === 'news' || view === 'agents');
    if (!needsTick || staticMode) return;
    setCooldownEpoch(Date.now());
    const id = setInterval(() => setCooldownEpoch(Date.now()), NEWS_COOLDOWN_TICK_MS);
    return () => clearInterval(id);
  }, [view, staticMode, backgroundPaused]);

  const teamsPoll = usePolling<Team[]>(
    (signal) => fetchTeams(manager, signal),
    TEAMS_POLL_MS,
    staticMode || backgroundPaused,
    [manager, teamsRefreshKey],
  );
  const teamsRaw = staticMode ? staticTeams ?? [] : teamsPoll.data ?? [];
  // Always render `public` immediately after the `All` chip, then the rest in
  // the order the manager returned them. Keeps the public team a stable
  // anchor as new teams are added.
  const teams = useMemo(() => orderTeams(teamsRaw), [teamsRaw]);

  const agentsFetcher = useCallback(
    (signal: AbortSignal): Promise<Agent[]> => {
      if (teams.length === 0) return Promise.resolve([]);
      return fetchAgentsAllTeams(manager, teams, signal);
    },
    [manager, teams],
  );

  const agentsPoll = usePolling<Agent[]>(
    agentsFetcher,
    AGENTS_POLL_MS,
    staticMode || backgroundPaused,
    [manager, teams.length, backgroundPaused],
  );
  const allAgents = staticMode ? staticAllAgents ?? [] : agentsPoll.data ?? [];

  // Per-agent news freshness — one batched fan-out per agents-poll cycle,
  // gated to the agents view so other views don't pay the cost.
  const newsFreshnessFetcher = useCallback(
    (signal: AbortSignal): Promise<Array<[string, number | null]>> => {
      if (allAgents.length === 0) return Promise.resolve([]);
      return fetchAgentsLatestNewsTs(manager, SELF_AGENT, allAgents, signal).then((m) => [
        ...m.entries(),
      ]);
    },
    [manager, allAgents],
  );
  const newsFreshnessPoll = usePolling<Array<[string, number | null]>>(
    newsFreshnessFetcher,
    AGENTS_POLL_MS,
    staticMode || backgroundPaused || view !== 'agents',
    [manager, allAgents.length, view, backgroundPaused],
  );
  const latestNewsTsById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const [id, ts] of newsFreshnessPoll.data ?? []) m.set(id, ts);
    return m;
  }, [newsFreshnessPoll.data]);
  const newsColorById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of allAgents) {
      const ts = latestNewsTsById.get(a.id) ?? null;
      m.set(a.id, ts == null ? 'gray' : newsAgeColor(ts, cooldownEpoch));
    }
    return m;
  }, [allAgents, latestNewsTsById, cooldownEpoch]);

  const visibleAgents = useMemo(
    () => filterAgentsByTeam(allAgents, selectedTeam),
    [allAgents, selectedTeam],
  );

  const teamCounts = useMemo(() => computeTeamCounts(allAgents), [allAgents]);

  const pollTs = staticMode
    ? staticAllAgents !== null
      ? Date.now()
      : 0
    : agentsPoll.lastUpdated;

  const uptimeById = useMemo(() => {
    const map = new Map<string, string>();
    if (pollTs === 0) return map;
    for (const a of allAgents) {
      map.set(a.id, humanizeUptime(a.createdAt, pollTs));
    }
    return map;
  }, [allAgents, pollTs]);

  // Per-agent memory — one batched `ps` call per poll tick. Pids come from
  // agent metadata persisted by the manager at spawn time; agents without a
  // pid (or whose pid is gone) render `—`. Gated to the agents view so we
  // don't fork ps when nothing is looking.
  const pidByAgentId = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of allAgents) {
      const pid = (a.metadata as { pid?: unknown } | undefined)?.pid;
      if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) {
        map.set(a.id, pid);
      }
    }
    return map;
  }, [allAgents]);

  const memoryFetcher = useCallback(
    (signal: AbortSignal): Promise<Array<[string, number | null]>> => {
      const pids = [...pidByAgentId.values()];
      if (pids.length === 0) return Promise.resolve([]);
      return fetchRssForPids(pids, signal).then((rssByPid) => {
        const out: Array<[string, number | null]> = [];
        for (const [agentId, pid] of pidByAgentId) {
          const bytes = rssByPid.get(pid);
          out.push([agentId, bytes ?? null]);
        }
        return out;
      });
    },
    [pidByAgentId],
  );
  const memoryPoll = usePolling<Array<[string, number | null]>>(
    memoryFetcher,
    AGENTS_POLL_MS,
    staticMode || backgroundPaused || view !== 'agents',
    [pidByAgentId, view, backgroundPaused],
  );
  const memBytesById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const [id, bytes] of memoryPoll.data ?? []) m.set(id, bytes);
    return m;
  }, [memoryPoll.data]);
  // Only local agents contribute to total memory — remote agents have no
  // RSS. Build a set of local agent IDs so the sum excludes remote rows.
  const localAgentIds = useMemo(() => selectLocalAgentIds(allAgents), [allAgents]);

  const totalMemoryBytes = useMemo(() => {
    let sum = 0;
    for (const [id, bytes] of memBytesById) {
      if (!localAgentIds.has(id)) continue;
      if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0) sum += bytes;
    }
    return sum;
  }, [memBytesById, localAgentIds]);
  const totalMemoryLabel = useMemo(() => formatTotalMemory(totalMemoryBytes), [totalMemoryBytes]);
  const totalMemoryColor = useMemo(() => totalMemColor(totalMemoryBytes), [totalMemoryBytes]);

  const rows = stdout?.rows ?? 30;
  const agentsWindowSize = Math.max(MIN_VISIBLE, rows - AGENTS_CHROME_ROWS);
  const newsWindowSize = Math.max(MIN_VISIBLE, rows - NEWS_CHROME_ROWS);
  const detailWindowSize = Math.max(MIN_VISIBLE, rows - DETAIL_CHROME_ROWS);
  const helpWindowSize = helpWindowSizeForRows(rows);
  const tasksWindowSize = Math.max(MIN_VISIBLE, rows - TASKS_CHROME_ROWS);
  const calendarWindowSize = Math.max(MIN_VISIBLE, rows - CALENDAR_CHROME_ROWS);
  const heartbeatsWindowSize = Math.max(MIN_VISIBLE, rows - HEARTBEATS_CHROME_ROWS);
  const libraryWindowSize = Math.max(MIN_VISIBLE, rows - LIBRARY_CHROME_ROWS);
  const configsWindowSize = libraryWindowSize;
  const outputWindowSize = libraryWindowSize;
  const total = visibleAgents.length;

  // Tasks polling — fan out across all teams in parallel so allTasks is
  // the union and task counts stay stable when the operator switches the
  // selected team. visibleTasks narrows by selectedTeam client-side.
  const tasksFetcher = useCallback(
    (signal: AbortSignal): Promise<Task[]> =>
      fetchTasksAllTeams(manager, SELF_AGENT, teams, signal),
    [manager, teams],
  );
  const tasksPoll = usePolling<Task[]>(
    tasksFetcher,
    TASKS_POLL_MS,
    staticMode || (view !== 'tasks' && view !== 'task-detail'),
    [manager, view, teams.length],
  );
  const allTasks = tasksPoll.data ?? [];
  const visibleTasks = useMemo(
    () => filterTasksByTeam(allTasks, selectedTeam),
    [allTasks, selectedTeam],
  );
  const tasksTotal = visibleTasks.length;
  const ageByTaskName = useMemo(() => {
    const map = new Map<string, string>();
    const tsPoll = tasksPoll.lastUpdated;
    if (tsPoll === 0) return map;
    for (const t of allTasks) {
      // task.createdAt is unix seconds; convert to ms for humanizeUptime
      map.set(t.name, humanizeUptime(t.createdAt * 1000, tsPoll));
    }
    return map;
  }, [allTasks, tasksPoll.lastUpdated]);

  useEffect(() => {
    const next = clampScroll(taskSelectedIndex, taskWindowStart, tasksTotal, tasksWindowSize);
    if (next.index !== taskSelectedIndex) setTaskSelectedIndex(next.index);
    if (next.windowStart !== taskWindowStart) setTaskWindowStart(next.windowStart);
  }, [tasksTotal, taskSelectedIndex, taskWindowStart, tasksWindowSize]);

  const selectedTaskName = visibleTasks[taskSelectedIndex]?.name ?? null;

  // Schedules polling — drives Calendar view.
  const schedulesFetcher = useCallback(
    (signal: AbortSignal): Promise<Schedule[]> => {
      if (teams.length === 0) return Promise.resolve([]);
      return fetchSchedulesAllTeams(manager, SELF_AGENT, teams, signal);
    },
    [manager, teams],
  );
  const schedulesPoll = usePolling<Schedule[]>(
    schedulesFetcher,
    SCHEDULES_POLL_MS,
    staticMode || (view !== 'calendar' && view !== 'heartbeats'),
    [manager, teams.length, view],
  );
  const allSchedules = schedulesPoll.data ?? [];
  // Calendar excludes heartbeat-kind schedules — those already appear on
  // the Heartbeats page, so duplicating them here just adds noise.
  const calendarSchedules = useMemo(
    () => filterCalendarSchedules(allSchedules),
    [allSchedules],
  );
  const schedTotal = calendarSchedules.length;

  const heartbeatRows = useMemo<HeartbeatRow[]>(() => {
    const pollMs = schedulesPoll.lastUpdated || Date.now();
    const nowSec = Math.floor(pollMs / 1000);
    const out: HeartbeatRow[] = [];
    for (const s of allSchedules) {
      if (s.kind !== 'heartbeat') continue;
      if (!s.intervalSeconds || s.intervalSeconds <= 0) continue;
      const anchor = s.createdAt;
      const interval = s.intervalSeconds;
      const elapsed = nowSec - anchor;
      const nLast = Math.floor(elapsed / interval);
      const lastFireSec = nLast >= 0 ? anchor + nLast * interval : null;
      const nextFireSec = anchor + (nLast + 1) * interval;
      for (const agent of s.targets) {
        out.push({ agent, schedule: s, intervalSec: interval, lastFireSec, nextFireSec });
      }
    }
    out.sort((a, b) => {
      if (a.nextFireSec !== b.nextFireSec) return a.nextFireSec - b.nextFireSec;
      return a.agent.localeCompare(b.agent);
    });
    return out;
  }, [allSchedules, schedulesPoll.lastUpdated]);

  // Heartbeats is a cross-team view, same shape as Calendar — no team
  // filter or TeamsPanel chrome. See Calendar: drop top teams-chips bar.
  const hbTotal = heartbeatRows.length;

  useEffect(() => {
    const next = clampScroll(hbSelectedIndex, hbWindowStart, hbTotal, heartbeatsWindowSize);
    if (next.index !== hbSelectedIndex) setHbSelectedIndex(next.index);
    if (next.windowStart !== hbWindowStart) setHbWindowStart(next.windowStart);
  }, [hbTotal, hbSelectedIndex, hbWindowStart, heartbeatsWindowSize]);

  useEffect(() => {
    const next = clampScroll(schedSelectedIndex, schedWindowStart, schedTotal, calendarWindowSize);
    if (next.index !== schedSelectedIndex) setSchedSelectedIndex(next.index);
    if (next.windowStart !== schedWindowStart) setSchedWindowStart(next.windowStart);
  }, [schedTotal, schedSelectedIndex, schedWindowStart, calendarWindowSize]);

  const tasksTeamCounts = useMemo(() => countByTeam(allTasks), [allTasks]);

  useEffect(() => {
    const next = clampScroll(selectedIndex, windowStart, total, agentsWindowSize);
    if (next.index !== selectedIndex) setSelectedIndex(next.index);
    if (next.windowStart !== windowStart) setWindowStart(next.windowStart);
  }, [total, selectedIndex, windowStart, agentsWindowSize]);

  const selectedAgent = visibleAgents[selectedIndex] ?? null;
  const selectedAgentName: string | null = selectedAgent?.name ?? null;
  const selectedAgentId: string | null = selectedAgent?.id ?? null;
  const selectedAgentTeam: string | null = selectedAgent?.teamName ?? null;

  const newsFetcher = useCallback(
    (signal: AbortSignal): Promise<NewsItem[]> => {
      if (!selectedAgentName) return Promise.resolve([]);
      return fetchAgentNews(manager, SELF_AGENT, selectedAgentName, signal, selectedAgentTeam ?? undefined);
    },
    [manager, selectedAgentName, selectedAgentTeam],
  );

  const newsPoll = usePolling<NewsItem[]>(
    newsFetcher,
    NEWS_POLL_MS,
    staticMode || (view !== 'news' && view !== 'news-detail'),
    [manager, selectedAgentName ?? '', selectedAgentTeam ?? '', view],
  );
  const newsItems = newsPoll.data ?? [];
  const sortedNewsItems = useMemo(
    () => sortNewsByTimestamp(newsItems),
    [newsItems],
  );
  const newsTotal = sortedNewsItems.length;
  const selectedNewsItem: NewsItem | null = sortedNewsItems[newsSelectedIndex] ?? null;

  const [detailScroll, setDetailScroll] = useState(0);
  const [taskDetailScroll, setTaskDetailScroll] = useState(0);
  const [hbDetailScroll, setHbDetailScroll] = useState(0);
  const [agentDetailScroll, setAgentDetailScroll] = useState(0);

  useEffect(() => {
    const next = clampScroll(newsSelectedIndex, newsWindowStart, newsTotal, newsWindowSize);
    if (next.index !== newsSelectedIndex) setNewsSelectedIndex(next.index);
    if (next.windowStart !== newsWindowStart) setNewsWindowStart(next.windowStart);
  }, [newsTotal, newsSelectedIndex, newsWindowStart, newsWindowSize]);

  const teamOptions: Array<string | null> = useMemo(
    () => [null, ...teams.map((t) => t.name)],
    [teams],
  );

  const cycleTeam = useCallback(
    (dir: 1 | -1) => {
      if (teamOptions.length === 0) return;
      const current = teamOptions.indexOf(selectedTeam);
      const base = current === -1 ? 0 : current;
      const next = (base + dir + teamOptions.length) % teamOptions.length;
      setSelectedTeam(teamOptions[next]);
      setSelectedIndex(0);
      setWindowStart(0);
    },
    [teamOptions, selectedTeam],
  );

  const moveAgentsSel = useCallback(
    (delta: number) => {
      if (total === 0) return;
      setSelectedIndex((idx) => clamp(idx + delta, 0, total - 1));
    },
    [total],
  );

  const moveNewsSel = useCallback(
    (delta: number) => {
      if (newsTotal === 0) return;
      setNewsSelectedIndex((idx) => clamp(idx + delta, 0, newsTotal - 1));
    },
    [newsTotal],
  );

  const moveTaskSel = useCallback(
    (delta: number) => {
      if (tasksTotal === 0) return;
      setTaskSelectedIndex((idx) => clamp(idx + delta, 0, tasksTotal - 1));
    },
    [tasksTotal],
  );

  const toggleTasksView = useCallback(() => {
    setView((v) => (v === 'tasks' ? 'agents' : v === 'agents' ? 'tasks' : v));
  }, []);

  const moveSchedSel = useCallback(
    (delta: number) => {
      if (schedTotal === 0) return;
      setSchedSelectedIndex((idx) => clamp(idx + delta, 0, schedTotal - 1));
    },
    [schedTotal],
  );

  const openCalendar = useCallback(() => {
    setSchedSelectedIndex(0);
    setSchedWindowStart(0);
    setView('calendar');
  }, []);

  const openHeartbeats = useCallback(() => {
    setHbSelectedIndex(0);
    setHbWindowStart(0);
    setView('heartbeats');
  }, []);

  const openHeartbeatDetail = useCallback(() => {
    setHbDetailScroll(0);
    setView('heartbeat-detail');
  }, []);

  const backToHeartbeats = useCallback(() => {
    setView('heartbeats');
  }, []);

  const moveHbDetailScroll = useCallback(
    (delta: number) => {
      setHbDetailScroll((off) => Math.max(0, off + delta));
    },
    [],
  );

  const moveHbSel = useCallback(
    (delta: number) => {
      if (hbTotal === 0) return;
      setHbSelectedIndex((idx) => clamp(idx + delta, 0, hbTotal - 1));
    },
    [hbTotal],
  );

  const openAgentDetail = useCallback(() => {
    if (!selectedAgent) return;
    const isRemote = selectedAgent.deploymentShape === 'remote-endpoint' ||
      selectedAgent.metadata?.runtime === 'public-agent-remote';
    if (!isRemote) return; // local agents drill into news instead
    setAgentDetailScroll(0);
    setView('agent-detail');
  }, [selectedAgent]);

  const backFromAgentDetail = useCallback(() => {
    setView('agents');
  }, []);

  const moveAgentDetailScroll = useCallback(
    (delta: number) => {
      setAgentDetailScroll((off) => Math.max(0, off + delta));
    },
    [],
  );

  const openNews = useCallback(() => {
    if (!selectedAgentName) return;
    setNewsSelectedIndex(0);
    setNewsWindowStart(0);
    setView('news');
  }, [selectedAgentName]);

  const openNewsDetail = useCallback(() => {
    if (!selectedNewsItem) return;
    setDetailScroll(0);
    setView('news-detail');
  }, [selectedNewsItem]);

  const openTaskDetail = useCallback(() => {
    if (tasksTotal === 0) return;
    setTaskDetailScroll(0);
    setView('task-detail');
  }, [tasksTotal]);

  const backToTasks = useCallback(() => {
    setView('tasks');
  }, []);

  const moveTaskDetailScroll = useCallback(
    (delta: number) => {
      setTaskDetailScroll((off) => Math.max(0, off + delta));
    },
    [],
  );

  const backToAgents = useCallback(() => {
    setView('agents');
  }, []);

  const backToNews = useCallback(() => {
    setView('news');
  }, []);

  const moveDetailScroll = useCallback(
    (delta: number) => {
      setDetailScroll((off) => Math.max(0, off + delta));
    },
    [],
  );

  // ---------------------------------------------------------------- Library
  // Read-only browser fed by slice-7 manager /library/* endpoints. No
  // filesystem access from the TUI; cadence matches TasksTable.
  const libraryAgentsFetcher = useCallback(
    (signal: AbortSignal): Promise<LibraryAgentListResponse> =>
      fetchLibraryAgents(manager, signal),
    [manager],
  );
  const libraryAgentsPoll = usePolling<LibraryAgentListResponse>(
    libraryAgentsFetcher,
    LIBRARY_POLL_MS,
    staticMode || (view !== 'library-agents' && view !== 'library-agent-detail'),
    [manager, view],
  );
  const libraryAgentRows = libraryAgentsPoll.data?.entries ?? [];
  const libraryAgentRoot = libraryAgentsPoll.data?.libraryRoot ?? null;
  const libraryAgentErrors = libraryAgentsPoll.data?.errors ?? [];
  const libraryAgentTotal = libraryAgentRows.length;
  const selectedLibraryAgentName = libraryAgentRows[libAgentSelectedIndex]?.name ?? null;

  const librarySkillsFetcher = useCallback(
    (signal: AbortSignal): Promise<LibrarySkillListResponse> =>
      fetchLibrarySkills(manager, signal),
    [manager],
  );
  const librarySkillsPoll = usePolling<LibrarySkillListResponse>(
    librarySkillsFetcher,
    LIBRARY_POLL_MS,
    staticMode || (view !== 'library-skills' && view !== 'library-skill-detail'),
    [manager, view],
  );
  const librarySkillRows = librarySkillsPoll.data?.entries ?? [];
  const librarySkillRoot = librarySkillsPoll.data?.libraryRoot ?? null;
  const librarySkillTotal = librarySkillRows.length;
  const selectedLibrarySkillName = librarySkillRows[libSkillSelectedIndex]?.name ?? null;

  const libraryAgentDetailFetcher = useCallback(
    (signal: AbortSignal): Promise<LibraryAgentDetailResponse | null> => {
      if (!selectedLibraryAgentName) return Promise.resolve(null);
      return fetchLibraryAgent(manager, selectedLibraryAgentName, signal);
    },
    [manager, selectedLibraryAgentName],
  );
  const libraryAgentDetailPoll = usePolling<LibraryAgentDetailResponse | null>(
    libraryAgentDetailFetcher,
    LIBRARY_POLL_MS,
    staticMode || view !== 'library-agent-detail' || !selectedLibraryAgentName,
    [manager, selectedLibraryAgentName ?? '', view],
  );

  const librarySkillDetailFetcher = useCallback(
    (signal: AbortSignal): Promise<LibrarySkillDetailResponse | null> => {
      if (!selectedLibrarySkillName) return Promise.resolve(null);
      return fetchLibrarySkill(manager, selectedLibrarySkillName, signal);
    },
    [manager, selectedLibrarySkillName],
  );
  const librarySkillDetailPoll = usePolling<LibrarySkillDetailResponse | null>(
    librarySkillDetailFetcher,
    LIBRARY_POLL_MS,
    staticMode || view !== 'library-skill-detail' || !selectedLibrarySkillName,
    [manager, selectedLibrarySkillName ?? '', view],
  );

  // Window/selection clamping for the two library list views, matching the
  // pattern used by tasks/heartbeats above.
  useEffect(() => {
    if (libraryAgentTotal === 0) {
      if (libAgentSelectedIndex !== 0) setLibAgentSelectedIndex(0);
      if (libAgentWindowStart !== 0) setLibAgentWindowStart(0);
      return;
    }
    const clampedSel = Math.min(libAgentSelectedIndex, libraryAgentTotal - 1);
    if (clampedSel !== libAgentSelectedIndex) setLibAgentSelectedIndex(clampedSel);
    const maxStart = Math.max(0, libraryAgentTotal - libraryWindowSize);
    let nextStart = libAgentWindowStart;
    if (clampedSel < nextStart) nextStart = clampedSel;
    if (clampedSel >= nextStart + libraryWindowSize)
      nextStart = clampedSel - libraryWindowSize + 1;
    if (nextStart > maxStart) nextStart = maxStart;
    if (nextStart < 0) nextStart = 0;
    if (nextStart !== libAgentWindowStart) setLibAgentWindowStart(nextStart);
  }, [libraryAgentTotal, libAgentSelectedIndex, libAgentWindowStart, libraryWindowSize]);

  useEffect(() => {
    if (librarySkillTotal === 0) {
      if (libSkillSelectedIndex !== 0) setLibSkillSelectedIndex(0);
      if (libSkillWindowStart !== 0) setLibSkillWindowStart(0);
      return;
    }
    const clampedSel = Math.min(libSkillSelectedIndex, librarySkillTotal - 1);
    if (clampedSel !== libSkillSelectedIndex) setLibSkillSelectedIndex(clampedSel);
    const maxStart = Math.max(0, librarySkillTotal - libraryWindowSize);
    let nextStart = libSkillWindowStart;
    if (clampedSel < nextStart) nextStart = clampedSel;
    if (clampedSel >= nextStart + libraryWindowSize)
      nextStart = clampedSel - libraryWindowSize + 1;
    if (nextStart > maxStart) nextStart = maxStart;
    if (nextStart < 0) nextStart = 0;
    if (nextStart !== libSkillWindowStart) setLibSkillWindowStart(nextStart);
  }, [librarySkillTotal, libSkillSelectedIndex, libSkillWindowStart, libraryWindowSize]);

  const moveLibraryAgentSel = useCallback(
    (delta: number) => {
      if (libraryAgentTotal === 0) return;
      setLibAgentSelectedIndex((idx) => clamp(idx + delta, 0, libraryAgentTotal - 1));
    },
    [libraryAgentTotal],
  );

  const moveLibrarySkillSel = useCallback(
    (delta: number) => {
      if (librarySkillTotal === 0) return;
      setLibSkillSelectedIndex((idx) => clamp(idx + delta, 0, librarySkillTotal - 1));
    },
    [librarySkillTotal],
  );

  const openLibraryAgents = useCallback(() => {
    setLibAgentSelectedIndex(0);
    setLibAgentWindowStart(0);
    setView('library-agents');
  }, []);

  const openLibrarySkills = useCallback(() => {
    setLibSkillSelectedIndex(0);
    setLibSkillWindowStart(0);
    setView('library-skills');
  }, []);

  const openLibraryAgentDetail = useCallback(() => {
    if (!selectedLibraryAgentName) return;
    setLibAgentDetailScroll(0);
    setView('library-agent-detail');
  }, [selectedLibraryAgentName]);

  const openLibrarySkillDetail = useCallback(() => {
    if (!selectedLibrarySkillName) return;
    setLibSkillDetailScroll(0);
    setView('library-skill-detail');
  }, [selectedLibrarySkillName]);

  const moveLibraryAgentDetailScroll = useCallback((delta: number) => {
    setLibAgentDetailScroll((off) => Math.max(0, off + delta));
  }, []);

  const moveLibrarySkillDetailScroll = useCallback((delta: number) => {
    setLibSkillDetailScroll((off) => Math.max(0, off + delta));
  }, []);

  // ---------------------------------------------------------------- Library teams
  // Slice 4 wires the same poll/window/select trio used for the agents
  // and skills lists, plus an install action keyed by `i` from the
  // detail view. The install state is local-only (no polling) — the
  // backend write is one-shot and the result renders inline until the
  // user navigates away.
  const libraryTeamsFetcher = useCallback(
    (signal: AbortSignal): Promise<LibraryTeamListResponse> =>
      fetchLibraryTeams(manager, signal),
    [manager],
  );
  const libraryTeamsPoll = usePolling<LibraryTeamListResponse>(
    libraryTeamsFetcher,
    LIBRARY_POLL_MS,
    staticMode || (view !== 'library-teams' && view !== 'library-team-detail'),
    [manager, view],
  );
  const libraryTeamRows = libraryTeamsPoll.data?.entries ?? [];
  const libraryTeamRoot = libraryTeamsPoll.data?.libraryRoot ?? null;
  const libraryTeamTotal = libraryTeamRows.length;
  const selectedLibraryTeamName = libraryTeamRows[libTeamSelectedIndex]?.name ?? null;

  const libraryTeamDetailFetcher = useCallback(
    (signal: AbortSignal): Promise<LibraryTeamDetailResponse | null> => {
      if (!selectedLibraryTeamName) return Promise.resolve(null);
      return fetchLibraryTeam(manager, selectedLibraryTeamName, signal);
    },
    [manager, selectedLibraryTeamName],
  );
  const libraryTeamDetailPoll = usePolling<LibraryTeamDetailResponse | null>(
    libraryTeamDetailFetcher,
    LIBRARY_POLL_MS,
    staticMode || view !== 'library-team-detail' || !selectedLibraryTeamName,
    [manager, selectedLibraryTeamName ?? '', view],
  );

  useEffect(() => {
    if (libraryTeamTotal === 0) {
      if (libTeamSelectedIndex !== 0) setLibTeamSelectedIndex(0);
      if (libTeamWindowStart !== 0) setLibTeamWindowStart(0);
      return;
    }
    const clampedSel = Math.min(libTeamSelectedIndex, libraryTeamTotal - 1);
    if (clampedSel !== libTeamSelectedIndex) setLibTeamSelectedIndex(clampedSel);
    const maxStart = Math.max(0, libraryTeamTotal - libraryWindowSize);
    let nextStart = libTeamWindowStart;
    if (clampedSel < nextStart) nextStart = clampedSel;
    if (clampedSel >= nextStart + libraryWindowSize)
      nextStart = clampedSel - libraryWindowSize + 1;
    if (nextStart > maxStart) nextStart = maxStart;
    if (nextStart < 0) nextStart = 0;
    if (nextStart !== libTeamWindowStart) setLibTeamWindowStart(nextStart);
  }, [libraryTeamTotal, libTeamSelectedIndex, libTeamWindowStart, libraryWindowSize]);

  const moveLibraryTeamSel = useCallback(
    (delta: number) => {
      if (libraryTeamTotal === 0) return;
      setLibTeamSelectedIndex((idx) => clamp(idx + delta, 0, libraryTeamTotal - 1));
    },
    [libraryTeamTotal],
  );

  const openLibraryTeams = useCallback(() => {
    setLibTeamSelectedIndex(0);
    setLibTeamWindowStart(0);
    setLibTeamInstallState({ kind: 'idle' });
    setView('library-teams');
  }, []);

  const openLibraryTeamDetail = useCallback(() => {
    if (!selectedLibraryTeamName) return;
    setLibTeamDetailScroll(0);
    setLibTeamInstallState({ kind: 'idle' });
    setView('library-team-detail');
  }, [selectedLibraryTeamName]);

  const moveLibraryTeamDetailScroll = useCallback((delta: number) => {
    setLibTeamDetailScroll((off) => Math.max(0, off + delta));
  }, []);

  // Kicks off POST /library/install with selectors team:<template> →
  // team:<dest>. The backend handles AST rewrite, provenance header,
  // and atomic rename; we just transition install state for the UI.
  const runLibraryTeamInstall = useCallback(
    async (template: string, dest: string, force: boolean) => {
      setLibTeamInstallState({ kind: 'running', dest });
      const ac = new AbortController();
      try {
        const result = await installLibraryTeam(
          manager,
          { template, dest, force },
          ac.signal,
        );
        setLibTeamInstallState({ kind: 'success', result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setLibTeamInstallState({ kind: 'error', message });
      }
    },
    [manager],
  );

  // ---------------------------------------------------------------- Configs
  // Local filesystem browser for configs/*.yaml. This is intentionally
  // TUI-side, not a /remote daemon command, because the dashboard process
  // already has access to the project checkout.
  const configRows = useMemo(() => listConfigFiles(), [configRefreshKey]);
  const configTotal = configRows.length;
  const selectedConfig = configRows[configSelectedIndex] ?? null;
  const configDetail = useMemo(() => {
    if (!selectedConfig) return { contents: null, error: null as Error | null };
    try {
      return { contents: readFileSync(selectedConfig.absolutePath, 'utf8'), error: null as Error | null };
    } catch (err: unknown) {
      return {
        contents: null,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }, [selectedConfig]);

  useEffect(() => {
    if (configTotal === 0) {
      if (configSelectedIndex !== 0) setConfigSelectedIndex(0);
      if (configWindowStart !== 0) setConfigWindowStart(0);
      return;
    }
    const clampedSel = Math.min(configSelectedIndex, configTotal - 1);
    if (clampedSel !== configSelectedIndex) setConfigSelectedIndex(clampedSel);
    const maxStart = Math.max(0, configTotal - configsWindowSize);
    let nextStart = configWindowStart;
    if (clampedSel < nextStart) nextStart = clampedSel;
    if (clampedSel >= nextStart + configsWindowSize)
      nextStart = clampedSel - configsWindowSize + 1;
    if (nextStart > maxStart) nextStart = maxStart;
    if (nextStart < 0) nextStart = 0;
    if (nextStart !== configWindowStart) setConfigWindowStart(nextStart);
  }, [configTotal, configSelectedIndex, configWindowStart, configsWindowSize]);

  const openConfigs = useCallback(() => {
    setConfigRefreshKey((k) => k + 1);
    setConfigSelectedIndex(0);
    setConfigWindowStart(0);
    setView('configs-list');
  }, []);

  const openConfigDetail = useCallback(() => {
    if (!selectedConfig) return;
    setConfigDetailScroll(0);
    setView('config-detail');
  }, [selectedConfig]);

  const moveConfigSel = useCallback(
    (delta: number) => {
      if (configTotal === 0) return;
      setConfigSelectedIndex((idx) => clamp(idx + delta, 0, configTotal - 1));
    },
    [configTotal],
  );

  const moveConfigDetailScroll = useCallback((delta: number) => {
    setConfigDetailScroll((off) => Math.max(0, off + delta));
  }, []);

  // ---------------------------------------------------------------- Output
  // TUI-side browser for an agent's ./output directory. The agent is scoped
  // from the command argument and resolved from the existing /agents data.
  const outputAgent = useMemo(() => {
    if (!outputAgentName) return null;
    return allAgents.find((a) =>
      a.name === outputAgentName && (!outputTeamName || a.teamName === outputTeamName)
    ) ?? allAgents.find((a) => a.name === outputAgentName) ?? null;
  }, [allAgents, outputAgentName, outputTeamName]);
  const outputRows = useMemo(
    () => listOutputFiles(outputAgent?.workingDirectory),
    [outputAgent?.workingDirectory, outputRefreshKey],
  );
  const outputTotal = outputRows.length;
  const selectedOutputFile = outputRows[outputSelectedIndex] ?? null;
  const outputListError = outputAgentName && !outputAgent
    ? `agent not found in /agents response: ${outputAgentName}`
    : outputAgent && !outputAgent.workingDirectory
      ? `agent has no workingDirectory: ${outputAgent.name}`
      : null;
  const outputDetail = useMemo(() => {
    if (!selectedOutputFile) return { contents: null, error: null as Error | null };
    try {
      return { contents: readOutputFileDetail(selectedOutputFile), error: null as Error | null };
    } catch (err: unknown) {
      return {
        contents: null,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }, [selectedOutputFile]);

  useEffect(() => {
    if (outputTotal === 0) {
      if (outputSelectedIndex !== 0) setOutputSelectedIndex(0);
      if (outputWindowStart !== 0) setOutputWindowStart(0);
      return;
    }
    const clampedSel = Math.min(outputSelectedIndex, outputTotal - 1);
    if (clampedSel !== outputSelectedIndex) setOutputSelectedIndex(clampedSel);
    const maxStart = Math.max(0, outputTotal - outputWindowSize);
    let nextStart = outputWindowStart;
    if (clampedSel < nextStart) nextStart = clampedSel;
    if (clampedSel >= nextStart + outputWindowSize)
      nextStart = clampedSel - outputWindowSize + 1;
    if (nextStart > maxStart) nextStart = maxStart;
    if (nextStart < 0) nextStart = 0;
    if (nextStart !== outputWindowStart) setOutputWindowStart(nextStart);
  }, [outputTotal, outputSelectedIndex, outputWindowStart, outputWindowSize]);

  const openOutput = useCallback((agentName: string, teamName?: string) => {
    setOutputAgentName(agentName);
    setOutputTeamName(teamName ?? null);
    setOutputRefreshKey((k) => k + 1);
    setOutputSelectedIndex(0);
    setOutputWindowStart(0);
    setOutputDetailScroll(0);
    setView('output-list');
  }, []);

  const openOutputDetail = useCallback(() => {
    if (!selectedOutputFile) return;
    setOutputDetailScroll(0);
    setView('output-detail');
  }, [selectedOutputFile]);

  const moveOutputSel = useCallback(
    (delta: number) => {
      if (outputTotal === 0) return;
      setOutputSelectedIndex((idx) => clamp(idx + delta, 0, outputTotal - 1));
    },
    [outputTotal],
  );

  const moveOutputDetailScroll = useCallback((delta: number) => {
    setOutputDetailScroll((off) => Math.max(0, off + delta));
  }, []);

  // Execute a command-bar entry. Validation, dispatch, and result/error
  // capture are centralized here so the keystroke handler stays simple.
  const runCommand = useCallback(
    async (raw: string) => {
      const parsed = parseCommandLine(raw);
      if (!parsed) {
        setCommandError({ kind: 'manager', message: 'empty command' });
        return;
      }
      const spec = lookupCommand(parsed.name);
      if (!spec) {
        setCommandError({
          kind: 'manager',
          message: `unknown command: ${parsed.name} (known: ${knownCommandNames().join(', ')})`,
        });
        return;
      }
      // Resolve the X-Id-Team header. For agent-targeted commands we always
      // search every team by agent name so the dispatch lands where the
      // agent actually lives, ignoring the currently-selected team. Same-
      // name agents in different teams are ambiguous: report and bail.
      // For non-agent-targeted commands, fall back to the selected team.
      let resolvedTeam: string | undefined = selectedTeam ?? undefined;
      // Skip cross-team resolution when the first arg is clearly not an agent
      // name: flags (`--team`, `--force`, ...) and the `*` wildcard. Those
      // dispatch to the daemon's flag/glob handler with the X-Id-Team header
      // pointing at the currently-selected team.
      const firstArgLooksLikeAgent = parsed.args.length > 0
        && parsed.args[0] !== '*'
        && !parsed.args[0]!.startsWith('-');
      if (AGENT_TARGETED_COMMANDS.has(parsed.name) && firstArgLooksLikeAgent) {
        const targetName = parsed.args[0];
        // Match exact names AND ENS-style prefix shorthands (`cli` should
        // match `cli.agent-28.xid.eth`). Mirrors the daemon's lenient name
        // resolution so the operator can use the short form everywhere.
        const matches = allAgents.filter(
          (a) => a.name === targetName || a.name.startsWith(`${targetName}.`),
        );
        const distinctTeams = Array.from(new Set(matches.map((m) => m.teamName)));
        if (distinctTeams.length === 1) {
          resolvedTeam = distinctTeams[0];
        } else if (distinctTeams.length > 1) {
          setCommandError({
            kind: 'manager',
            message: `${parsed.name}: agent "${targetName}" exists in multiple teams (${distinctTeams.join(', ')}). Switch to the team you want first.`,
          });
          return;
        } else {
          setCommandError({
            kind: 'manager',
            message: `${parsed.name}: agent "${targetName}" not found in any team.`,
          });
          return;
        }
      }
      if (!resolvedTeam) {
        resolvedTeam = teams.find((t) => t.name !== 'public')?.name;
      }
      const ac = new AbortController();
      setCommandRunning(true);
      setCommandError(null);
      try {
        const data = await spec.run({
          manager,
          executor: SELF_AGENT,
          signal: ac.signal,
          args: parsed.args,
          teamName: resolvedTeam,
        });
        if (isTuiAction(data)) {
          setCommandResult(null);
          setCommandResultScroll(0);
          if (data.tuiAction === 'help') {
            setShowHelp(true);
            setHelpScroll(0);
            setCommandError(null);
            return;
          }
          if (data.tuiAction === 'configs') {
            openConfigs();
            setCommandError(null);
            return;
          }
          if (data.tuiAction === 'output') {
            openOutput(data.agent, resolvedTeam);
            setCommandError(null);
            return;
          }
        }
        const renderer = typeof spec.resultRenderer === 'function'
          ? spec.resultRenderer(parsed.args)
          : spec.resultRenderer ?? 'auto';
        const table = renderer === 'json' ? null : detectTabularResult(data);
        const tableError = renderer === 'table' && !table
          ? `expected tabular result, got: ${previewJson(data)}`
          : null;
        const text = JSON.stringify(data, null, 2);
        setCommandResult({
          command: raw,
          text,
          renderer,
          table,
          tableError,
          showJson: false,
        });
        setCommandResultScroll(0);
        if (TEAM_MUTATING_COMMANDS.has(parsed.name)) {
          setTeamsRefreshKey((k) => k + 1);
        }
        // `/team <name>` switches the dashboard to that team. `/team delete
        // <name>` does NOT switch — the deleted team disappears, and we
        // leave the operator's current view alone. Team names are lowercase
        // by convention; normalize so `/team Idchain` and `/team idchain`
        // both land on the same selection.
        if (parsed.name === 'team'
          && parsed.args.length === 1
          && parsed.args[0]?.toLowerCase() !== 'delete') {
          setSelectedTeam(parsed.args[0]!.toLowerCase());
          setSelectedIndex(0);
          setWindowStart(0);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Phase 6: typed errors from runRemoteCommand → split rendering.
        // Anything else (catalog-side issues, JSON parse, etc.) is
        // treated as 'manager' since it didn't originate from the
        // network layer.
        const kind: 'network' | 'manager' = err instanceof NetworkError
          ? 'network'
          : err instanceof ManagerError
            ? 'manager'
            : 'manager';
        setCommandError({ kind, message: `${parsed.name}: ${msg}` });
      } finally {
        setCommandRunning(false);
      }
    },
    [manager, selectedTeam, teams, allAgents, openConfigs, openOutput],
  );

  useInput(
    (input, key) => {
      // Quit confirmation — intercepts q when not yet confirmed. Ctrl-C still
      // exits immediately (users who want a hard quit have it). Inside the
      // confirmation, Enter / y commits, Esc / n cancels.
      if (showQuitConfirm) {
        if (key.return || input === 'y' || input === 'Y') {
          exit();
          return;
        }
        if (key.escape || input === 'n' || input === 'N' || (key.ctrl && input === 'c')) {
          setShowQuitConfirm(false);
          return;
        }
        return; // swallow everything else while the dialog is open
      }
      // Help view (Phase 5) — scrollable list of every catalog entry
      // grouped by risk tier. j/k/arrows scroll, Esc / ? / q close.
      // Ctrl+C still exits the app. All other keys swallowed.
      if (showHelp) {
        if (key.ctrl && input === 'c') {
          exit();
          return;
        }
        if (key.escape || key.leftArrow || input === '?' || input === 'q') {
          setShowHelp(false);
          setHelpScroll(0);
          return;
        }
        if (input === 'k' || key.upArrow) {
          setHelpScroll((s) => Math.max(0, s - 1));
          return;
        }
        if (input === 'j' || key.downArrow) {
          setHelpScroll((s) => s + 1);
          return;
        }
        if (key.pageUp) {
          setHelpScroll((s) => Math.max(0, s - helpWindowSize));
          return;
        }
        if (key.pageDown) {
          setHelpScroll((s) => s + helpWindowSize);
          return;
        }
        if (isHomeKey(input)) {
          setHelpScroll(0);
          return;
        }
        if (isEndKey(input)) {
          setHelpScroll(Number.MAX_SAFE_INTEGER);
          return;
        }
        // Single-letter view shortcuts close help and switch in one
        // keystroke — matches what the help text itself documents
        // under "Views". Reuses the same dispatch/openers the per-view
        // input blocks already call so behavior is identical.
        if (
          input === 'a' || input === 't' || input === 'n' ||
          input === 'c' || input === 'h' || input === 'l' || input === 's' ||
          input === 'm'
        ) {
          setShowHelp(false);
          setHelpScroll(0);
          if (input === 'a') return setView('agents');
          if (input === 't') return setView('tasks');
          if (input === 'n') return setView('news');
          if (input === 'c') return openCalendar();
          if (input === 'h') return openHeartbeats();
          if (input === 'l') return openLibraryAgents();
          if (input === 's') return openLibrarySkills();
          if (input === 'm') return openLibraryTeams();
          return;
        }
        // ':' / '/' close help and open the command bar with that
        // sigil already in the buffer — same shape as the global
        // command-mode entry path.
        if (input === ':' || input === '/') {
          setShowHelp(false);
          setHelpScroll(0);
          setCommandMode(true);
          setCommandBuffer(input);
          setCommandHistoryIndex(null);
          return;
        }
        return; // swallow everything else
      }
      // Retype prompt (Phase 4) — owns every keystroke. Enter checks
      // for an exact match against the expected line; mismatch clears
      // the typed buffer and surfaces an inline error inside the
      // prompt box. Esc cancels at any time. Tab is swallowed (no
      // completion in retype mode — that would defeat the gate).
      if (commandRetype) {
        if (key.ctrl && input === 'c') {
          exit();
          return;
        }
        if (key.escape) {
          setCommandRetype(null);
          return;
        }
        if (key.return) {
          if (commandRetype.typed === commandRetype.expected) {
            const expected = commandRetype.expected;
            setCommandRetype(null);
            void runCommand(expected);
          } else {
            setCommandRetype((c) => (c ? { ...c, typed: '', mismatchSeen: true } : c));
          }
          return;
        }
        if (key.backspace || key.delete) {
          setCommandRetype((c) => (c ? { ...c, typed: c.typed.slice(0, -1) } : c));
          return;
        }
        if (key.tab) {
          return; // explicitly no completion in retype mode
        }
        if (input && !key.ctrl && !key.meta) {
          setCommandRetype((c) => (c ? { ...c, typed: c.typed + input } : c));
        }
        return;
      }

      // Confirmation prompt (Phase 3) — owns every keystroke until the
      // user picks Y/N or hits Esc. Y dispatches the staged command;
      // N / Esc / Ctrl+C discard it. Ctrl+C also exits the app, matching
      // global behavior.
      if (commandPending) {
        if (key.ctrl && input === 'c') {
          exit();
          return;
        }
        if (key.return || input === 'y' || input === 'Y') {
          const { raw } = commandPending;
          setCommandPending(null);
          void runCommand(raw);
          return;
        }
        if (key.escape || input === 'n' || input === 'N') {
          setCommandPending(null);
          return;
        }
        return; // swallow everything else while the prompt is open
      }

      // Command bar (editing) — owns every keystroke until Enter or Esc.
      // Backspace stops at the entry sigil so the user always sees the
      // mode indicator (`:` or `/`) until they explicitly cancel.
      if (commandMode) {
        if (key.escape) {
          setCommandMode(false);
          setCommandBuffer('');
          setCommandHistoryIndex(null);
          return;
        }
        if (key.return) {
          const raw = commandBuffer;
          const stripped = raw.replace(/^[:/]+/, '').trim();
          if (stripped.length > 0) {
            setCommandHistory((h) => (h.length > 0 && h[h.length - 1] === raw ? h : [...h, raw]));
          }
          setCommandHistoryIndex(null);
          setCommandMode(false);
          setCommandBuffer('');
          const parsed = parseCommandLine(raw);
          // Phase 3/4 gate: parse and check the spec's confirmation
          // tier. Retype short-circuits Y/N when both predicates fire,
          // so the user only sees the higher-tier prompt.
          const spec = parsed ? lookupCommand(parsed.name) : null;
          const level = parsed && spec ? confirmationLevel(spec, parsed.args) : 'none';
          if (level === 'retype' && parsed && spec) {
            setCommandRetype({
              expected: raw.replace(/^[:/]+/, ''),
              preview: commandConfirmPreview(spec, parsed.args, { teamCounts }) ?? raw,
              typed: '',
              mismatchSeen: false,
            });
            setCommandError(null);
          } else if (level === 'yn' && parsed && spec) {
            setCommandPending({
              raw,
              preview: commandConfirmPreview(spec, parsed.args, { teamCounts }) ?? raw,
            });
            setCommandError(null);
          } else {
            void runCommand(raw);
          }
          return;
        }
        if (key.upArrow) {
          if (commandHistory.length === 0) return;
          const next =
            commandHistoryIndex === null
              ? commandHistory.length - 1
              : Math.max(0, commandHistoryIndex - 1);
          setCommandHistoryIndex(next);
          setCommandBuffer(commandHistory[next] ?? '');
          return;
        }
        if (key.downArrow) {
          if (commandHistory.length === 0 || commandHistoryIndex === null) return;
          const next = commandHistoryIndex + 1;
          if (next >= commandHistory.length) {
            setCommandHistoryIndex(null);
            setCommandBuffer('');
          } else {
            setCommandHistoryIndex(next);
            setCommandBuffer(commandHistory[next] ?? '');
          }
          return;
        }
        if (key.backspace || key.delete) {
          setCommandBuffer((b) => (b.length > 1 ? b.slice(0, -1) : b));
          return;
        }
        if (key.tab) {
          // Phase 6: command-name completion (first token) or
          // arg-level completion (subsequent slots) via the spec's
          // argCompleter. Completion context is assembled from data the
          // dashboard already has in scope.
          const completed = completeBuffer(commandBuffer, {
            agentNames: allAgents.map((a) => a.name),
            teamNames: teams.map((t) => t.name),
          });
          if (completed !== null) {
            setCommandBuffer(completed);
            setCommandHistoryIndex(null);
          }
          return;
        }
        if (key.ctrl && input === 'c') {
          exit();
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setCommandBuffer((b) => b + input);
        }
        return;
      }

      // Command result is showing — Esc clears, arrows scroll, `:` / `/`
      // re-open the bar without dismissing the result so the user can
      // chain queries while keeping the previous output visible. Global
      // keys (q, ?, Ctrl+C) still pass through.
      if (commandResult && commandResultConsumesInput(input, key, {
        canShowJson: Boolean(commandResult.table || commandResult.tableError) && !commandResult.showJson,
      })) {
        if (key.escape || key.leftArrow || key.return) {
          setCommandResult(null);
          setCommandError(null);
          setCommandResultScroll(0);
          return;
        }
        if (input === ':' || input === '/') {
          setCommandMode(true);
          setCommandBuffer(input);
          setCommandHistoryIndex(null);
          return;
        }
        if (key.ctrl && input === 'c') {
          exit();
          return;
        }
        if (input === 'q') {
          setShowQuitConfirm(true);
          return;
        }
        if (input === '?') {
          setShowHelp(true);
          return;
        }
        if (input === 'j' && (commandResult.table || commandResult.tableError) && !commandResult.showJson) {
          setCommandResult({ ...commandResult, showJson: true });
          setCommandResultScroll(0);
          return;
        }
        if (key.upArrow) {
          setCommandResultScroll((s) => Math.max(0, s - 1));
          return;
        }
        if (key.downArrow) {
          setCommandResultScroll((s) => s + 1);
          return;
        }
        if (key.pageUp) {
          setCommandResultScroll((s) => Math.max(0, s - detailWindowSize));
          return;
        }
        if (key.pageDown) {
          setCommandResultScroll((s) => s + detailWindowSize);
          return;
        }
        return;
      }

      // global
      if (key.ctrl && input === 'c') {
        exit();
        return;
      }
      if (input === ':' || input === '/') {
        setCommandMode(true);
        setCommandBuffer(input);
        setCommandHistoryIndex(null);
        return;
      }
      if (input === 'q') {
        setShowQuitConfirm(true);
        return;
      }
      if (input === '?') {
        setShowHelp(true);
        return;
      }
      if (view === 'agents') {
        if (input === 't') return toggleTasksView();
        if (input === 'c') return openCalendar();
        if (input === 'h') return openHeartbeats();
        if (input === 'l') return openLibraryAgents();
        if (input === 's') return openLibrarySkills();
        if (input === 'm') return openLibraryTeams();
        if (key.rightArrow) {
          // Remote agents get the detail panel; local agents get news
          const isRemote = selectedAgent?.deploymentShape === 'remote-endpoint' ||
            selectedAgent?.metadata?.runtime === 'public-agent-remote';
          return isRemote ? openAgentDetail() : openNews();
        }
        if (key.tab) return cycleTeam(key.shift ? -1 : 1);
        if (key.upArrow) return moveAgentsSel(-1);
        if (key.downArrow) return moveAgentsSel(1);
        if (key.pageUp) return moveAgentsSel(-agentsWindowSize);
        if (key.pageDown) return moveAgentsSel(agentsWindowSize);
        if (isHomeKey(input)) return setSelectedIndex(0);
        if (isEndKey(input)) return setSelectedIndex(Math.max(0, total - 1));
        return;
      }

      if (view === 'configs-list') {
        if (input === 'a') return setView('agents');
        if (input === 't') return setView('tasks');
        if (input === 'c') return openCalendar();
        if (input === 'h') return openHeartbeats();
        if (input === 'l') return openLibraryAgents();
        if (input === 's') return openLibrarySkills();
        if (key.leftArrow || key.escape) return setView('agents');
        if (key.rightArrow) return openConfigDetail();
        if (key.return) return copyPathToClipboard(selectedConfig?.absolutePath);
        if (input === 'k' || key.upArrow) return moveConfigSel(-1);
        if (input === 'j' || key.downArrow) return moveConfigSel(1);
        if (key.pageUp) return moveConfigSel(-configsWindowSize);
        if (key.pageDown) return moveConfigSel(configsWindowSize);
        if (isHomeKey(input)) return setConfigSelectedIndex(0);
        if (isEndKey(input)) return setConfigSelectedIndex(Math.max(0, configTotal - 1));
        return;
      }

      if (view === 'config-detail') {
        if (key.leftArrow || key.escape) return setView('configs-list');
        if (key.return) return copyPathToClipboard(selectedConfig?.absolutePath);
        if (input === 'k' || key.upArrow) return moveConfigDetailScroll(-1);
        if (input === 'j' || key.downArrow) return moveConfigDetailScroll(1);
        if (key.pageUp) return moveConfigDetailScroll(-detailWindowSize);
        if (key.pageDown) return moveConfigDetailScroll(detailWindowSize);
        if (isHomeKey(input)) return setConfigDetailScroll(0);
        if (isEndKey(input)) return setConfigDetailScroll(Number.MAX_SAFE_INTEGER);
        return;
      }

      if (view === 'output-list') {
        if (input === 'a') return setView('agents');
        if (input === 't') return setView('tasks');
        if (input === 'c') return openCalendar();
        if (input === 'h') return openHeartbeats();
        if (input === 'l') return openLibraryAgents();
        if (input === 's') return openLibrarySkills();
        if (key.leftArrow || key.escape) return setView('agents');
        if (key.rightArrow) return openOutputDetail();
        if (key.return) return copyPathToClipboard(selectedOutputFile?.absolutePath);
        if (input === 'k' || key.upArrow) return moveOutputSel(-1);
        if (input === 'j' || key.downArrow) return moveOutputSel(1);
        if (key.pageUp) return moveOutputSel(-outputWindowSize);
        if (key.pageDown) return moveOutputSel(outputWindowSize);
        if (isHomeKey(input)) return setOutputSelectedIndex(0);
        if (isEndKey(input)) return setOutputSelectedIndex(Math.max(0, outputTotal - 1));
        return;
      }

      if (view === 'output-detail') {
        if (key.leftArrow || key.escape) return setView('output-list');
        if (key.return) return copyPathToClipboard(selectedOutputFile?.absolutePath);
        if (input === 'k' || key.upArrow) return moveOutputDetailScroll(-1);
        if (input === 'j' || key.downArrow) return moveOutputDetailScroll(1);
        if (key.pageUp) return moveOutputDetailScroll(-detailWindowSize);
        if (key.pageDown) return moveOutputDetailScroll(detailWindowSize);
        if (isHomeKey(input)) return setOutputDetailScroll(0);
        if (isEndKey(input)) return setOutputDetailScroll(Number.MAX_SAFE_INTEGER);
        return;
      }

      if (view === 'tasks') {
        if (input === 't') return toggleTasksView();
        if (input === 'c') return openCalendar();
        if (input === 'h') return openHeartbeats();
        if (input === 'l') return openLibraryAgents();
        if (input === 's') return openLibrarySkills();
        if (input === 'm') return openLibraryTeams();
        if (key.leftArrow || key.escape) return setView('agents');
        if (key.rightArrow) return openTaskDetail();
        if (key.tab) return cycleTeam(key.shift ? -1 : 1);
        if (key.upArrow) return moveTaskSel(-1);
        if (key.downArrow) return moveTaskSel(1);
        if (key.pageUp) return moveTaskSel(-tasksWindowSize);
        if (key.pageDown) return moveTaskSel(tasksWindowSize);
        if (isHomeKey(input)) return setTaskSelectedIndex(0);
        if (isEndKey(input)) return setTaskSelectedIndex(Math.max(0, tasksTotal - 1));
        return;
      }

      if (view === 'task-detail') {
        if (key.leftArrow || key.escape) return backToTasks();
        if (key.upArrow) return moveTaskDetailScroll(-1);
        if (key.downArrow) return moveTaskDetailScroll(1);
        if (key.pageUp) return moveTaskDetailScroll(-detailWindowSize);
        if (key.pageDown) return moveTaskDetailScroll(detailWindowSize);
        if (isHomeKey(input)) return setTaskDetailScroll(0);
        if (isEndKey(input)) return setTaskDetailScroll(Number.MAX_SAFE_INTEGER);
        return;
      }

      if (view === 'calendar') {
        if (input === 'a') return setView('agents');
        if (input === 't') return setView('tasks');
        if (input === 'h') return openHeartbeats();
        if (input === 'l') return openLibraryAgents();
        if (input === 's') return openLibrarySkills();
        if (input === 'm') return openLibraryTeams();
        if (key.leftArrow || key.escape) return setView('agents');
        if (key.upArrow) return moveSchedSel(-1);
        if (key.downArrow) return moveSchedSel(1);
        if (key.pageUp) return moveSchedSel(-calendarWindowSize);
        if (key.pageDown) return moveSchedSel(calendarWindowSize);
        if (isHomeKey(input)) return setSchedSelectedIndex(0);
        if (isEndKey(input)) return setSchedSelectedIndex(Math.max(0, schedTotal - 1));
        return;
      }

      if (view === 'agent-detail') {
        if (key.leftArrow || key.escape) return backFromAgentDetail();
        if (key.upArrow) return moveAgentDetailScroll(-1);
        if (key.downArrow) return moveAgentDetailScroll(1);
        if (key.pageUp) return moveAgentDetailScroll(-detailWindowSize);
        if (key.pageDown) return moveAgentDetailScroll(detailWindowSize);
        if (isHomeKey(input)) return setAgentDetailScroll(0);
        if (isEndKey(input)) return setAgentDetailScroll(Number.MAX_SAFE_INTEGER);
        return;
      }

      if (view === 'heartbeats') {
        if (input === 'a') return setView('agents');
        if (input === 't') return setView('tasks');
        if (input === 'c') return openCalendar();
        if (input === 'l') return openLibraryAgents();
        if (input === 's') return openLibrarySkills();
        if (input === 'm') return openLibraryTeams();
        // Manual heartbeat fire — operator/debug action distinct from
        // the scheduled cadence. Stages a Y/N confirm so an errant `f`
        // keystroke never wakes an agent without intent. The pending
        // prompt runs through the same dispatch path as `:heartbeat
        // fire <agent>` typed in the bar, so confirm-tier logic stays
        // single-sourced in commands/registry.ts.
        if (input === 'f') {
          const sel = heartbeatRows[hbSelectedIndex];
          if (sel) {
            const raw = `/heartbeat fire ${sel.agent}`;
            setCommandPending({
              raw,
              preview: `manually fire heartbeat for agent ${sel.agent}`,
            });
          }
          return;
        }
        if (key.leftArrow || key.escape) return setView('agents');
        if (key.rightArrow) return openHeartbeatDetail();
        if (key.upArrow) return moveHbSel(-1);
        if (key.downArrow) return moveHbSel(1);
        if (key.pageUp) return moveHbSel(-heartbeatsWindowSize);
        if (key.pageDown) return moveHbSel(heartbeatsWindowSize);
        if (isHomeKey(input)) return setHbSelectedIndex(0);
        if (isEndKey(input)) return setHbSelectedIndex(Math.max(0, hbTotal - 1));
        return;
      }

      if (view === 'heartbeat-detail') {
        if (key.leftArrow || key.escape) return backToHeartbeats();
        if (key.upArrow) return moveHbDetailScroll(-1);
        if (key.downArrow) return moveHbDetailScroll(1);
        if (key.pageUp) return moveHbDetailScroll(-detailWindowSize);
        if (key.pageDown) return moveHbDetailScroll(detailWindowSize);
        if (isHomeKey(input)) return setHbDetailScroll(0);
        if (isEndKey(input)) return setHbDetailScroll(Number.MAX_SAFE_INTEGER);
        return;
      }

      if (view === 'library-agents') {
        if (input === 'a') return setView('agents');
        if (input === 't') return setView('tasks');
        if (input === 'c') return openCalendar();
        if (input === 'h') return openHeartbeats();
        if (input === 's') return openLibrarySkills();
        if (input === 'm') return openLibraryTeams();
        if (key.leftArrow || key.escape) return setView('agents');
        if (key.rightArrow) return openLibraryAgentDetail();
        if (key.upArrow) return moveLibraryAgentSel(-1);
        if (key.downArrow) return moveLibraryAgentSel(1);
        if (key.pageUp) return moveLibraryAgentSel(-libraryWindowSize);
        if (key.pageDown) return moveLibraryAgentSel(libraryWindowSize);
        if (isHomeKey(input)) return setLibAgentSelectedIndex(0);
        if (isEndKey(input)) return setLibAgentSelectedIndex(Math.max(0, libraryAgentTotal - 1));
        return;
      }

      if (view === 'library-agent-detail') {
        if (key.leftArrow || key.escape) return setView('library-agents');
        if (key.upArrow) return moveLibraryAgentDetailScroll(-1);
        if (key.downArrow) return moveLibraryAgentDetailScroll(1);
        if (key.pageUp) return moveLibraryAgentDetailScroll(-detailWindowSize);
        if (key.pageDown) return moveLibraryAgentDetailScroll(detailWindowSize);
        if (isHomeKey(input)) return setLibAgentDetailScroll(0);
        if (isEndKey(input)) return setLibAgentDetailScroll(Number.MAX_SAFE_INTEGER);
        return;
      }

      if (view === 'library-skills') {
        if (input === 'a') return setView('agents');
        if (input === 't') return setView('tasks');
        if (input === 'c') return openCalendar();
        if (input === 'h') return openHeartbeats();
        if (input === 'l') return openLibraryAgents();
        if (input === 'm') return openLibraryTeams();
        if (key.leftArrow || key.escape) return openLibraryAgents();
        if (key.rightArrow) return openLibrarySkillDetail();
        if (key.upArrow) return moveLibrarySkillSel(-1);
        if (key.downArrow) return moveLibrarySkillSel(1);
        if (key.pageUp) return moveLibrarySkillSel(-libraryWindowSize);
        if (key.pageDown) return moveLibrarySkillSel(libraryWindowSize);
        if (isHomeKey(input)) return setLibSkillSelectedIndex(0);
        if (isEndKey(input)) return setLibSkillSelectedIndex(Math.max(0, librarySkillTotal - 1));
        return;
      }

      if (view === 'library-skill-detail') {
        if (key.leftArrow || key.escape) return setView('library-skills');
        if (key.upArrow) return moveLibrarySkillDetailScroll(-1);
        if (key.downArrow) return moveLibrarySkillDetailScroll(1);
        if (key.pageUp) return moveLibrarySkillDetailScroll(-detailWindowSize);
        if (key.pageDown) return moveLibrarySkillDetailScroll(detailWindowSize);
        if (isHomeKey(input)) return setLibSkillDetailScroll(0);
        if (isEndKey(input)) return setLibSkillDetailScroll(Number.MAX_SAFE_INTEGER);
        return;
      }

      if (view === 'library-teams') {
        if (input === 'a') return setView('agents');
        if (input === 't') return setView('tasks');
        if (input === 'c') return openCalendar();
        if (input === 'h') return openHeartbeats();
        if (input === 'l') return openLibraryAgents();
        if (input === 's') return openLibrarySkills();
        if (key.leftArrow || key.escape) return setView('agents');
        if (key.rightArrow) return openLibraryTeamDetail();
        if (key.upArrow) return moveLibraryTeamSel(-1);
        if (key.downArrow) return moveLibraryTeamSel(1);
        if (key.pageUp) return moveLibraryTeamSel(-libraryWindowSize);
        if (key.pageDown) return moveLibraryTeamSel(libraryWindowSize);
        if (isHomeKey(input)) return setLibTeamSelectedIndex(0);
        if (isEndKey(input)) return setLibTeamSelectedIndex(Math.max(0, libraryTeamTotal - 1));
        return;
      }

      if (view === 'library-team-detail') {
        // Install prompt owns keystrokes while it's open: dest editing,
        // Enter dispatches, F toggles force, Esc cancels back to idle.
        if (libTeamInstallState.kind === 'prompt') {
          const template = libraryTeamDetailPoll.data?.name ?? selectedLibraryTeamName ?? null;
          if (key.escape) {
            setLibTeamInstallState({ kind: 'idle' });
            return;
          }
          if (key.return) {
            if (!template) return;
            const dest = libTeamInstallState.dest.trim();
            if (!dest) return;
            void runLibraryTeamInstall(template, dest, libTeamInstallState.force);
            return;
          }
          if (key.backspace || key.delete) {
            setLibTeamInstallState((s) =>
              s.kind === 'prompt' ? { ...s, dest: s.dest.slice(0, -1) } : s,
            );
            return;
          }
          if (input === 'F') {
            setLibTeamInstallState((s) => (s.kind === 'prompt' ? { ...s, force: !s.force } : s));
            return;
          }
          if (input && !key.ctrl && !key.meta && /^[a-zA-Z0-9_-]$/.test(input)) {
            setLibTeamInstallState((s) =>
              s.kind === 'prompt' ? { ...s, dest: s.dest + input } : s,
            );
            return;
          }
          return;
        }
        if (input === 'i' && (libTeamInstallState.kind === 'idle' || libTeamInstallState.kind === 'success' || libTeamInstallState.kind === 'error')) {
          const template = libraryTeamDetailPoll.data?.name ?? selectedLibraryTeamName ?? '';
          setLibTeamInstallState({ kind: 'prompt', dest: template, force: false });
          return;
        }
        if (key.leftArrow || key.escape) {
          setLibTeamInstallState({ kind: 'idle' });
          return setView('library-teams');
        }
        if (key.upArrow) return moveLibraryTeamDetailScroll(-1);
        if (key.downArrow) return moveLibraryTeamDetailScroll(1);
        if (key.pageUp) return moveLibraryTeamDetailScroll(-detailWindowSize);
        if (key.pageDown) return moveLibraryTeamDetailScroll(detailWindowSize);
        if (isHomeKey(input)) return setLibTeamDetailScroll(0);
        if (isEndKey(input)) return setLibTeamDetailScroll(Number.MAX_SAFE_INTEGER);
        return;
      }

      if (view === 'news') {
        if (key.rightArrow) return openNewsDetail();
        if (key.leftArrow || key.escape) return backToAgents();
        if (key.upArrow) return moveNewsSel(-1);
        if (key.downArrow) return moveNewsSel(1);
        if (key.pageUp) return moveNewsSel(-newsWindowSize);
        if (key.pageDown) return moveNewsSel(newsWindowSize);
        if (isHomeKey(input)) return setNewsSelectedIndex(0);
        if (isEndKey(input)) return setNewsSelectedIndex(Math.max(0, newsTotal - 1));
        return;
      }

      // news-detail view
      if (key.leftArrow || key.escape) return backToNews();
      if (key.upArrow) return moveDetailScroll(-1);
      if (key.downArrow) return moveDetailScroll(1);
      if (key.pageUp) return moveDetailScroll(-detailWindowSize);
      if (key.pageDown) return moveDetailScroll(detailWindowSize);
      if (isHomeKey(input)) return setDetailScroll(0);
      if (isEndKey(input)) return setDetailScroll(Number.MAX_SAFE_INTEGER);
    },
    { isActive: process.stdin.isTTY === true },
  );

  const debugViewEnabled = process.env.ID_TUI_DEBUG_VIEW === '1';
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  const prevViewRef = useRef(view);
  useEffect(() => {
    if (prevViewRef.current !== view) {
      prevViewRef.current = view;
      setCommandResult(null);
      setCommandError(null);
      setCommandResultScroll(0);
    }
  }, [view]);

  useEffect(() => {
    if (!flashMessage) return;
    const t = setTimeout(() => setFlashMessage(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [flashMessage]);

  const copyPathToClipboard = useCallback((absolutePath: string | null | undefined) => {
    if (!absolutePath) return;
    const ok = copyToClipboard(absolutePath, stdout);
    setFlashMessage(ok ? `copied: ${absolutePath}` : `clipboard unavailable: ${absolutePath}`);
  }, [stdout]);

  return (
    <Box flexDirection="column">
      {debugViewEnabled ? (
        <Box paddingX={1}>
          <Text color="magenta">
            [debug] view={view} cmdResult={commandResult ? 'set' : 'null'}
            {' '}cmdErr={commandError ? 'set' : 'null'}
            {' '}cmdMode={commandMode ? '1' : '0'}
            {' '}showHelp={showHelp ? '1' : '0'}
            {' '}render#{renderCountRef.current}
          </Text>
        </Box>
      ) : null}
      {showQuitConfirm ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">Quit? </Text>
          <Text dimColor>Enter / y = yes   ·   Esc / n = no</Text>
        </Box>
      ) : null}
      {showHelp ? (
        <HelpView windowSize={helpWindowSize} scrollOffset={helpScroll} />
      ) : commandResult ? (
        commandResult.showJson || commandResult.renderer === 'json' || (!commandResult.table && !commandResult.tableError) ? (
          <CommandResultView
            command={commandResult.command}
            text={commandResult.text}
            windowSize={detailWindowSize}
            scrollOffset={commandResultScroll}
          />
        ) : (
          <Box flexDirection="column" borderStyle="round" borderColor={commandResult.tableError ? 'red' : 'cyan'} paddingX={1}>
            <Box justifyContent="space-between">
              <Text bold color={commandResult.tableError ? 'red' : 'cyan'}>cmd · {commandResult.command}</Text>
              <Text dimColor>
                {commandResult.table
                  ? `${commandResult.table.rows.length} rows · ↑↓ scroll · j JSON · Esc clear`
                  : 'j JSON fallback · Esc clear'}
              </Text>
            </Box>
            <Text dimColor> </Text>
            {commandResult.tableError ? (
              <>
                <Text color="red" wrap="truncate-end">{commandResult.tableError}</Text>
                <Text dimColor>press j to view raw JSON</Text>
                {Array.from({ length: Math.max(0, detailWindowSize - 2) }, (_, i) => (
                  <Text key={`cmd-table-error-pad-${i}`}> </Text>
                ))}
              </>
            ) : commandResult.table ? (
              <CommandResultTable
                rows={commandResult.table.rows}
                scroll={commandResultScroll}
                windowSize={detailWindowSize}
              />
            ) : null}
          </Box>
        )
      ) : view === 'agents' ? (
        <>
          <TeamsPanel
            teams={teams}
            selectedTeam={selectedTeam}
            allCount={allAgents.length}
            teamCounts={teamCounts}
          />
          <StatusStrip agents={allAgents} selectedAgentId={selectedAgentId} />
          <AgentsTable
            agents={visibleAgents}
            uptimeById={uptimeById}
            newsColorById={newsColorById}
            memBytesById={memBytesById}
            totalMemoryLabel={totalMemoryLabel}
            totalMemoryColor={totalMemoryColor}
            selectedIndex={selectedIndex}
            windowStart={windowStart}
            windowSize={agentsWindowSize}
            loading={agentsPoll.lastUpdated === 0 && !agentsPoll.error && !staticMode}
            error={agentsPoll.error}
            nowMs={pollTs || Date.now()}
          />
          {teamsPoll.error ? (
            <Box paddingX={1}>
              <Text color="red">teams error: {teamsPoll.error.message}</Text>
            </Box>
          ) : null}
        </>
      ) : view === 'agent-detail' ? (
        <AgentDetail
          agent={selectedAgent}
          positionLabel={
            total > 0 ? `agent ${selectedIndex + 1} of ${total}` : ''
          }
          windowSize={detailWindowSize}
          scrollOffset={agentDetailScroll}
          nowMs={pollTs || Date.now()}
        />
      ) : view === 'configs-list' ? (
        <ConfigsList
          entries={configRows}
          selectedIndex={configSelectedIndex}
          windowStart={configWindowStart}
          windowSize={configsWindowSize}
        />
      ) : view === 'config-detail' ? (
        <ConfigDetail
          config={selectedConfig}
          contents={configDetail.contents}
          error={configDetail.error}
          positionLabel={
            configTotal > 0
              ? `config ${configSelectedIndex + 1} of ${configTotal}`
              : ''
          }
          windowSize={detailWindowSize}
          scrollOffset={configDetailScroll}
        />
      ) : view === 'output-list' ? (
        <OutputList
          agentName={outputAgentName}
          entries={outputRows}
          selectedIndex={outputSelectedIndex}
          windowStart={outputWindowStart}
          windowSize={outputWindowSize}
          error={outputListError}
        />
      ) : view === 'output-detail' ? (
        <OutputDetail
          agentName={outputAgentName}
          file={selectedOutputFile}
          contents={outputDetail.contents}
          error={outputDetail.error}
          positionLabel={
            outputTotal > 0
              ? `file ${outputSelectedIndex + 1} of ${outputTotal}`
              : ''
          }
          windowSize={detailWindowSize}
          scrollOffset={outputDetailScroll}
        />
      ) : view === 'tasks' ? (
        <>
          <TeamsPanel
            teams={teams}
            selectedTeam={selectedTeam}
            allCount={allTasks.length}
            teamCounts={tasksTeamCounts}
          />
          <TasksTable
            tasks={visibleTasks}
            ageByName={ageByTaskName}
            selectedIndex={taskSelectedIndex}
            windowStart={taskWindowStart}
            windowSize={tasksWindowSize}
            loading={tasksPoll.lastUpdated === 0 && !tasksPoll.error && !staticMode}
            error={tasksPoll.error}
          />
        </>
      ) : view === 'calendar' ? (
        <CalendarView
          schedules={calendarSchedules}
          nowSec={Math.floor((schedulesPoll.lastUpdated || Date.now()) / 1000)}
          selectedIndex={schedSelectedIndex}
          windowStart={schedWindowStart}
          windowSize={calendarWindowSize}
          loading={schedulesPoll.lastUpdated === 0 && !schedulesPoll.error && !staticMode}
          error={schedulesPoll.error}
        />
      ) : view === 'heartbeats' ? (
        <HeartbeatsView
          rows={heartbeatRows}
          nowSec={Math.floor((schedulesPoll.lastUpdated || Date.now()) / 1000)}
          selectedIndex={hbSelectedIndex}
          windowStart={hbWindowStart}
          windowSize={heartbeatsWindowSize}
          loading={schedulesPoll.lastUpdated === 0 && !schedulesPoll.error && !staticMode}
          error={schedulesPoll.error}
        />
      ) : view === 'heartbeat-detail' ? (
        (() => {
          const sel = heartbeatRows[hbSelectedIndex];
          if (!sel) {
            return (
              <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold>heartbeat · (none selected)</Text>
                <Text dimColor> </Text>
                <Text dimColor>(no row selected — press ← to return)</Text>
                {Array.from({ length: Math.max(0, detailWindowSize - 1) }, (_, i) => (
                  <Text key={`pad-${i}`}> </Text>
                ))}
              </Box>
            );
          }
          const agent = allAgents.find((a) => a.name === sel.agent);
          return (
            <HeartbeatDetail
              agentName={sel.agent}
              workingDirectory={agent?.workingDirectory ?? null}
              intervalSec={sel.intervalSec}
              lastFireSec={sel.lastFireSec}
              nextFireSec={sel.nextFireSec}
              positionLabel={`agent ${hbSelectedIndex + 1} of ${hbTotal}`}
              windowSize={detailWindowSize}
              scrollOffset={hbDetailScroll}
            />
          );
        })()
      ) : view === 'task-detail' ? (
        <TaskDetail
          task={visibleTasks[taskSelectedIndex] ?? null}
          positionLabel={
            tasksTotal > 0 ? `task ${taskSelectedIndex + 1} of ${tasksTotal}` : ''
          }
          windowSize={detailWindowSize}
          scrollOffset={taskDetailScroll}
          contentWidth={DETAIL_CONTENT_WIDTH}
        />
      ) : view === 'library-agents' ? (
        <LibraryAgentsTable
          entries={libraryAgentRows}
          libraryRoot={libraryAgentRoot}
          errorCount={libraryAgentErrors.length}
          selectedIndex={libAgentSelectedIndex}
          windowStart={libAgentWindowStart}
          windowSize={libraryWindowSize}
          loading={libraryAgentsPoll.lastUpdated === 0 && !libraryAgentsPoll.error && !staticMode}
          error={libraryAgentsPoll.error}
        />
      ) : view === 'library-agent-detail' ? (
        <LibraryAgentDetail
          agent={libraryAgentDetailPoll.data ?? null}
          agentName={selectedLibraryAgentName}
          loading={
            libraryAgentDetailPoll.lastUpdated === 0 && !libraryAgentDetailPoll.error
          }
          error={libraryAgentDetailPoll.error}
          positionLabel={
            libraryAgentTotal > 0
              ? `agent ${libAgentSelectedIndex + 1} of ${libraryAgentTotal}`
              : ''
          }
          windowSize={detailWindowSize}
          scrollOffset={libAgentDetailScroll}
        />
      ) : view === 'library-skills' ? (
        <LibrarySkillsTable
          entries={librarySkillRows}
          libraryRoot={librarySkillRoot}
          selectedIndex={libSkillSelectedIndex}
          windowStart={libSkillWindowStart}
          windowSize={libraryWindowSize}
          loading={librarySkillsPoll.lastUpdated === 0 && !librarySkillsPoll.error && !staticMode}
          error={librarySkillsPoll.error}
        />
      ) : view === 'library-skill-detail' ? (
        <LibrarySkillDetail
          skill={librarySkillDetailPoll.data ?? null}
          skillName={selectedLibrarySkillName}
          loading={
            librarySkillDetailPoll.lastUpdated === 0 && !librarySkillDetailPoll.error
          }
          error={librarySkillDetailPoll.error}
          positionLabel={
            librarySkillTotal > 0
              ? `skill ${libSkillSelectedIndex + 1} of ${librarySkillTotal}`
              : ''
          }
          windowSize={detailWindowSize}
          scrollOffset={libSkillDetailScroll}
        />
      ) : view === 'library-teams' ? (
        <LibraryTeamsTable
          entries={libraryTeamRows}
          libraryRoot={libraryTeamRoot}
          selectedIndex={libTeamSelectedIndex}
          windowStart={libTeamWindowStart}
          windowSize={libraryWindowSize}
          loading={libraryTeamsPoll.lastUpdated === 0 && !libraryTeamsPoll.error && !staticMode}
          error={libraryTeamsPoll.error}
        />
      ) : view === 'library-team-detail' ? (
        <LibraryTeamDetail
          team={libraryTeamDetailPoll.data ?? null}
          teamName={selectedLibraryTeamName}
          loading={
            libraryTeamDetailPoll.lastUpdated === 0 && !libraryTeamDetailPoll.error
          }
          error={libraryTeamDetailPoll.error}
          positionLabel={
            libraryTeamTotal > 0
              ? `team ${libTeamSelectedIndex + 1} of ${libraryTeamTotal}`
              : ''
          }
          windowSize={detailWindowSize}
          scrollOffset={libTeamDetailScroll}
          installState={libTeamInstallState}
        />
      ) : view === 'news' ? (
        <NewsView
          agentName={selectedAgentName}
          items={sortedNewsItems}
          loading={newsPoll.lastUpdated === 0 && !newsPoll.error}
          error={newsPoll.error}
          windowStart={newsWindowStart}
          windowSize={newsWindowSize}
          selectedIndex={newsSelectedIndex}
          messageWidth={NEWS_MESSAGE_WIDTH}
          cooldownEpoch={cooldownEpoch}
        />
      ) : (
        <NewsDetail
          agentName={selectedAgentName}
          item={selectedNewsItem}
          positionLabel={
            selectedNewsItem && newsTotal > 0
              ? `item ${newsSelectedIndex + 1} of ${newsTotal}`
              : ''
          }
          windowSize={detailWindowSize}
          scrollOffset={detailScroll}
        />
      )}
      {flashMessage ? (
        <Box paddingX={1}>
          <Text color="green" wrap="truncate-end">{flashMessage}</Text>
        </Box>
      ) : null}
      {commandError ? (
        <Box paddingX={1}>
          <Text
            color={commandError.kind === 'network' ? 'yellow' : 'red'}
            wrap="truncate-end"
          >
            {commandError.kind === 'network' ? '⚠ network: ' : '! '}
            {commandError.message}
          </Text>
        </Box>
      ) : null}
      {commandRetype ? (
        <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
          <Text bold color="red">Retype to confirm</Text>
          <Text wrap="truncate-end">{commandRetype.preview}</Text>
          <Box>
            <Text dimColor>type exactly: </Text>
            <Text color="yellow">{commandRetype.expected}</Text>
          </Box>
          <Box>
            <Text>› </Text>
            <Text>{commandRetype.typed}</Text>
            <Text inverse> </Text>
          </Box>
          {commandRetype.mismatchSeen ? (
            <Text color="red">! exact match required — Esc to cancel</Text>
          ) : (
            <Text dimColor>Enter to confirm · Esc to cancel</Text>
          )}
        </Box>
      ) : null}
      {commandPending ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">Confirm</Text>
          <Text wrap="truncate-end">{commandPending.preview}</Text>
          <Text dimColor>(raw: {commandPending.raw})</Text>
          <Text dimColor>Enter / y = run · Esc / n = cancel</Text>
        </Box>
      ) : null}
      {commandMode ? <CommandBar buffer={commandBuffer} running={commandRunning} /> : null}
      <Footer view={view} />
    </Box>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function isTuiAction(value: unknown): value is
  | { tuiAction: 'help' | 'configs' }
  | { tuiAction: 'output'; agent: string } {
  if (typeof value !== 'object' || value === null) return false;
  const action = (value as { tuiAction?: unknown }).tuiAction;
  if (action === 'help' || action === 'configs') return true;
  return action === 'output' && typeof (value as { agent?: unknown }).agent === 'string';
}

function isHomeKey(input: string): boolean {
  return input === '\u001b[H' || input === '\u001bOH' || input === '\u001b[1~';
}

function isEndKey(input: string): boolean {
  return input === '\u001b[F' || input === '\u001bOF' || input === '\u001b[4~';
}
