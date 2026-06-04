/**
 * Single-elimination scheduling: 1v1 matches, winners advance until one champion.
 * Spreads matches across a target number of calendar days (as many per day as needed).
 */

function addDays(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

/** Round-by-round structure for single elimination */
export function getRoundStructure(participantCount) {
  if (participantCount < 2) return [];

  let remaining = participantCount;
  const rounds = [];
  let roundNumber = 1;

  while (remaining > 1) {
    const matches = Math.floor(remaining / 2);
    const byes = remaining % 2;
    rounds.push({
      roundNumber,
      name: null,
      matches,
      byes,
      playersIn: remaining,
    });
    remaining = matches + byes;
    roundNumber += 1;
  }

  return rounds;
}

export function buildRoundNames(participantCount) {
  const rounds = getRoundStructure(participantCount);
  const names = [];
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const n = r.playersIn;
    if (i === rounds.length - 1) names.push('Final');
    else if (i === rounds.length - 2) names.push('Semifinals');
    else if (i === rounds.length - 3 && rounds.length >= 4) names.push('Quarterfinals');
    else names.push(`Round of ${n}`);
  }
  return names;
}

/**
 * Build a day-by-day plan of 1v1 matches across targetDays calendar days.
 * Cannot finish faster than one round per day (winners must advance).
 */
export function calculateTournamentSchedule(participantCount, targetDays, options = {}) {
  if (participantCount < 2) {
    return {
      error: 'Need at least 2 participants in the bracket',
      approvedCount: participantCount,
      targetDays: 0,
      totalMatches: 0,
      totalRounds: 0,
      days: [],
      matchPlan: [],
    };
  }

  const rounds = getRoundStructure(participantCount);
  const totalMatches = rounds.reduce((sum, r) => sum + r.matches, 0);
  const minDays = rounds.length;
  const numDays = Math.max(1, Math.max(minDays, parseInt(targetDays, 10) || minDays));

  const start = options.startDate ? new Date(options.startDate) : new Date();
  start.setHours(0, 0, 0, 0);

  const dayPlans = Array.from({ length: numDays }, (_, i) => ({
    day: i + 1,
    date: addDays(start, i),
    label: `Day ${i + 1}`,
    matchesScheduled: 0,
    matches: [],
  }));

  const matchPlan = [];
  let dayPointer = 0;

  for (let ri = 0; ri < rounds.length; ri++) {
    const round = rounds[ri];
    const roundsRemainingAfter = rounds.length - ri - 1;
    const daysLeftInTournament = numDays - dayPointer;
    const daysForRound = Math.max(
      1,
      Math.min(round.matches, daysLeftInTournament - roundsRemainingAfter)
    );

    let matchesLeft = round.matches;
    let matchInRound = 1;
    let offset = 0;

    while (matchesLeft > 0 && dayPointer + offset < numDays) {
      const daysLeftInRound = Math.max(1, daysForRound - offset);
      const matchesThisDay = Math.ceil(matchesLeft / daysLeftInRound);
      const dayIndex = Math.min(dayPointer + offset, numDays - 1);
      const plan = dayPlans[dayIndex];

      for (let i = 0; i < matchesThisDay && matchesLeft > 0; i++) {
        const entry = {
          roundNumber: round.roundNumber,
          matchInRound,
          day: plan.day,
          date: plan.date,
        };
        plan.matches.push(entry);
        plan.matchesScheduled += 1;
        matchPlan.push(entry);
        matchInRound += 1;
        matchesLeft -= 1;
      }
      offset += 1;
    }

    dayPointer = Math.min(dayPointer + daysForRound, numDays - 1);
    if (ri < rounds.length - 1) {
      dayPointer = Math.min(dayPointer + 1, numDays - 1);
    }
  }

  return {
    approvedCount: participantCount,
    targetDays: numDays,
    minDays,
    totalRounds: rounds.length,
    totalMatches,
    rounds,
    days: dayPlans,
    matchPlan,
    summary: `${participantCount} players · ${totalMatches} head-to-head matches · ${numDays} day(s) · single elimination`,
    rules: [
      'Each match is 1v1; the winner advances to the next round.',
      `The bracket needs at least ${minDays} day(s) (one round per day minimum).`,
      `With ${numDays} day(s), up to ${Math.max(...dayPlans.map((d) => d.matchesScheduled), 0)} matches can be played on the busiest day.`,
    ],
  };
}

/** Lookup scheduled date for a bracket match */
export function getMatchScheduledDate(schedule, roundNumber, matchNumber) {
  if (!schedule?.matchPlan?.length) return null;
  const entry = schedule.matchPlan.find(
    (m) => m.roundNumber === roundNumber && m.matchInRound === matchNumber
  );
  return entry?.date ?? null;
}
