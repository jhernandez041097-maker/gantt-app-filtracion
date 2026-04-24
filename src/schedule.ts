export type CycleFillTarget = {
  id: string;
  cct: string;
  bbt: string;
  cantidadHl: string;
  lineas: string[];
  startDate: string;
  startHour: number;
  endDate: string;
  endHour: number;
};

export type Cycle = {
  id: number;
  startDate: string;
  startHour: number;
  endDate: string;
  endHour: number;
  producto: string;
  color: string;
  aseo: boolean;
  ccts: string;
  llenados: CycleFillTarget[];
  bbts: string;
  cantidadHl: string;
  lineaEnvasado: string;
  mezcla: boolean;
  origenMezclaTipo: "" | "bbt" | "cct";
  origenMezcla: string;
  proporcionMezcla: string;
  mantenimientoProgramado: boolean;
  mantenimientoCorrectivo: boolean;
  notas: string;
};

export type CycleDraft = Omit<Cycle, "id">;

export type CycleSegment = {
  key: string;
  cycleId: number;
  dayIndex: number;
  visibleDate: string;
  startHour: number;
  endHour: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
};

export type CycleBounds = {
  startSlot: number;
  endSlot: number;
};

export type ReflowResult = {
  cycles: Cycle[];
  movedIds: number[];
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const DAYS = ["LUN", "MAR", "MIE", "JUE", "VIE", "SAB", "DOM"];
export const HOURS = Array.from({ length: 24 }, (_, index) => index);

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function splitDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

export function toDateInputValue(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dateKeyToDaySerial(value: string) {
  const { year, month, day } = splitDateKey(value);
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

export function daySerialToDateKey(daySerial: number) {
  const date = new Date(daySerial * MS_PER_DAY);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDays(value: string, days: number) {
  return daySerialToDateKey(dateKeyToDaySerial(value) + days);
}

function getUtcDayOfWeek(value: string) {
  return new Date(dateKeyToDaySerial(value) * MS_PER_DAY).getUTCDay();
}

export function getStartOfWeek(value: Date | string) {
  const dateKey = typeof value === "string" ? value : toDateInputValue(value);
  const dayOfWeek = getUtcDayOfWeek(dateKey);
  const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  return addDays(dateKey, diff);
}

export function getDayIndexFromDate(value: string) {
  const dayOfWeek = getUtcDayOfWeek(value);
  return dayOfWeek === 0 ? 6 : dayOfWeek - 1;
}

export function formatDateLabel(value: string) {
  const { year, month, day } = splitDateKey(value);
  return `${pad(day)}/${pad(month)}/${year}`;
}

export function formatWeekLabel(weekStart: string) {
  return `${formatDateLabel(weekStart)} -> ${formatDateLabel(addDays(weekStart, 6))}`;
}

export function formatHour(hour: number) {
  return `${pad(hour)}:00`;
}

export function slotFromDateHour(date: string, hour: number) {
  return dateKeyToDaySerial(date) * 24 + hour;
}

export function rangeFromSlots(startSlot: number, endSlot: number) {
  const startDaySerial = Math.floor(startSlot / 24);
  const endDaySerial = Math.floor(endSlot / 24);

  return {
    startDate: daySerialToDateKey(startDaySerial),
    startHour: ((startSlot % 24) + 24) % 24,
    endDate: daySerialToDateKey(endDaySerial),
    endHour: ((endSlot % 24) + 24) % 24,
  };
}

export function getCycleBounds(cycle: Pick<Cycle, "startDate" | "startHour" | "endDate" | "endHour">): CycleBounds {
  return {
    startSlot: slotFromDateHour(cycle.startDate, cycle.startHour),
    endSlot: slotFromDateHour(cycle.endDate, cycle.endHour),
  };
}

export function getFillBounds(
  fill: Pick<CycleFillTarget, "startDate" | "startHour" | "endDate" | "endHour">
): CycleBounds {
  return {
    startSlot: slotFromDateHour(fill.startDate, fill.startHour),
    endSlot: slotFromDateHour(fill.endDate, fill.endHour),
  };
}

export function getCycleDurationHours(cycle: Pick<Cycle, "startDate" | "startHour" | "endDate" | "endHour">) {
  const { startSlot, endSlot } = getCycleBounds(cycle);
  return endSlot - startSlot;
}

export function getFillDurationHours(fill: Pick<CycleFillTarget, "startDate" | "startHour" | "endDate" | "endHour">) {
  const { startSlot, endSlot } = getFillBounds(fill);
  return endSlot - startSlot;
}

export function applyRangeToCycle(cycle: Cycle, startSlot: number, endSlot: number) {
  return {
    ...cycle,
    ...rangeFromSlots(startSlot, endSlot),
  };
}

export function applyRangeToFill(fill: CycleFillTarget, startSlot: number, endSlot: number) {
  return {
    ...fill,
    ...rangeFromSlots(startSlot, endSlot),
  };
}

export function shiftFill(fill: CycleFillTarget, deltaSlots: number) {
  const { startSlot, endSlot } = getFillBounds(fill);
  return applyRangeToFill(fill, startSlot + deltaSlots, endSlot + deltaSlots);
}

export function shiftCycle(cycle: Cycle, newStartSlot: number) {
  const { startSlot } = getCycleBounds(cycle);
  const duration = getCycleDurationHours(cycle);
  const deltaSlots = newStartSlot - startSlot;

  return {
    ...applyRangeToCycle(cycle, newStartSlot, newStartSlot + duration),
    llenados: cycle.llenados.map((fill) => shiftFill(fill, deltaSlots)),
  };
}

export function sortCycles(cycles: Cycle[]) {
  return [...cycles].sort((left, right) => {
    const leftBounds = getCycleBounds(left);
    const rightBounds = getCycleBounds(right);

    if (leftBounds.startSlot !== rightBounds.startSlot) {
      return leftBounds.startSlot - rightBounds.startSlot;
    }

    return left.id - right.id;
  });
}

export function findNextAvailableStart(
  cycles: Cycle[],
  duration: number,
  minStartSlot: number,
  excludeId?: number
) {
  let cursor = minStartSlot;

  for (const cycle of sortCycles(cycles.filter((item) => item.id !== excludeId))) {
    const { startSlot, endSlot } = getCycleBounds(cycle);

    if (endSlot <= cursor) continue;
    if (startSlot - cursor >= duration) return cursor;

    cursor = Math.max(cursor, endSlot);
  }

  return cursor;
}

export function arrangeCyclesWithPriority(cycles: Cycle[], target: Cycle): ReflowResult {
  const targetBounds = getCycleBounds(target);
  const fixedBefore: Cycle[] = [];
  const reflowPool: Cycle[] = [];

  for (const cycle of sortCycles(cycles.filter((item) => item.id !== target.id))) {
    const bounds = getCycleBounds(cycle);

    if (bounds.endSlot <= targetBounds.startSlot) {
      fixedBefore.push(cycle);
    } else {
      reflowPool.push(cycle);
    }
  }

  let cursor = targetBounds.endSlot;
  const movedIds: number[] = [];
  const reflowed = reflowPool.map((cycle) => {
    const bounds = getCycleBounds(cycle);
    const duration = bounds.endSlot - bounds.startSlot;
    const nextStart = Math.max(bounds.startSlot, cursor);

    cursor = nextStart + duration;

    if (nextStart !== bounds.startSlot) {
      movedIds.push(cycle.id);
      return shiftCycle(cycle, nextStart);
    }

    return cycle;
  });

  return {
    cycles: sortCycles([...fixedBefore, target, ...reflowed]),
    movedIds,
  };
}

export function overlapsRange(
  cycle: Pick<Cycle, "startDate" | "startHour" | "endDate" | "endHour">,
  rangeStartSlot: number,
  rangeEndSlot: number
) {
  const { startSlot, endSlot } = getCycleBounds(cycle);
  return startSlot < rangeEndSlot && endSlot > rangeStartSlot;
}

export function getVisibleWeekCycles(cycles: Cycle[], weekStart: string) {
  const weekStartSlot = slotFromDateHour(weekStart, 0);
  const weekEndSlot = slotFromDateHour(addDays(weekStart, 7), 0);

  return sortCycles(cycles.filter((cycle) => overlapsRange(cycle, weekStartSlot, weekEndSlot)));
}

export function getVisibleWeekSegments(cycles: Cycle[], weekStart: string): CycleSegment[] {
  const weekStartSlot = slotFromDateHour(weekStart, 0);
  const visibleCycles = getVisibleWeekCycles(cycles, weekStart);
  const segments: CycleSegment[] = [];

  visibleCycles.forEach((cycle) => {
    const { startSlot, endSlot } = getCycleBounds(cycle);

    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const dayStartSlot = weekStartSlot + dayIndex * 24;
      const dayEndSlot = dayStartSlot + 24;
      const segmentStart = Math.max(startSlot, dayStartSlot);
      const segmentEnd = Math.min(endSlot, dayEndSlot);

      if (segmentStart >= segmentEnd) continue;

      segments.push({
        key: `${cycle.id}-${dayIndex}`,
        cycleId: cycle.id,
        dayIndex,
        visibleDate: addDays(weekStart, dayIndex),
        startHour: segmentStart - dayStartSlot,
        endHour: segmentEnd - dayStartSlot,
        continuesBefore: startSlot < dayStartSlot,
        continuesAfter: endSlot > dayEndSlot,
      });
    }
  });

  return segments;
}
