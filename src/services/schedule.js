/**
 * Calculate tournament day groupings so matches fit within target days.
 * Single-elimination: total rounds = ceil(log2(n)), total matches = n - 1
 */
export function calculateTournamentSchedule(approvedCount, targetDays) {
  if (approvedCount < 2) {
    return { rounds: 0, totalMatches: 0, days: [], error: 'Need at least 2 approved participants' };
  }

  const days = Math.max(1, Math.min(targetDays, approvedCount - 1));
  const totalRounds = Math.ceil(Math.log2(approvedCount));
  const totalMatches = approvedCount - 1;

  const dayPlans = [];
  const startDate = new Date();
  startDate.setHours(0, 0, 0, 0);

  let matchesRemaining = totalMatches;
  let participantsRemaining = approvedCount;

  for (let d = 0; d < days; d++) {
    const daysLeft = days - d;
    const matchesThisDay = Math.ceil(matchesRemaining / daysLeft);
    const roundsThisDay = Math.min(
      matchesThisDay,
      Math.max(1, Math.ceil(Math.log2(participantsRemaining)))
    );

    const date = new Date(startDate);
    date.setDate(date.getDate() + d);

    dayPlans.push({
      day: d + 1,
      date: date.toISOString().split('T')[0],
      matchesScheduled: matchesThisDay,
      estimatedParticipants: participantsRemaining,
      roundsEstimate: roundsThisDay,
      label: `Day ${d + 1}`,
    });

    matchesRemaining -= matchesThisDay;
    participantsRemaining = Math.max(2, Math.ceil(participantsRemaining / 2));
    if (matchesRemaining <= 0) break;
  }

  return {
    approvedCount,
    targetDays: days,
    totalRounds,
    totalMatches,
    days: dayPlans,
    summary: `${approvedCount} players across ${dayPlans.length} day(s), ~${totalMatches} matches in ${totalRounds} elimination rounds`,
  };
}

export function buildRoundNames(participantCount) {
  const rounds = Math.ceil(Math.log2(participantCount));
  const names = [];
  const labels = ['Round of', 'Quarterfinals', 'Semifinals', 'Finals'];
  let n = participantCount;
  for (let i = 0; i < rounds; i++) {
    if (i === rounds - 1) names.push('Finals');
    else if (i === rounds - 2 && rounds >= 2) names.push('Semifinals');
    else if (i === rounds - 3 && rounds >= 3) names.push('Quarterfinals');
    else names.push(`Round of ${n}`);
    n = Math.ceil(n / 2);
  }
  return names;
}
