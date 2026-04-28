import React, { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  DAYS,
  HOURS,
  addDays,
  applyRangeToCycle,
  applyRangeToFill,
  arrangeCyclesWithPriority,
  findNextAvailableStart,
  formatDateLabel,
  formatHour,
  formatWeekLabel,
  getCycleBounds,
  getCycleDurationHours,
  getDayIndexFromDate,
  getFillBounds,
  getFillDurationHours,
  getStartOfWeek,
  getVisibleWeekCycles,
  getVisibleWeekSegments,
  rangeFromSlots,
  shiftCycle,
  shiftFill,
  slotFromDateHour,
  sortCycles,
  toDateInputValue,
} from "./schedule";
import type { Cycle, CycleDraft, CycleFillTarget } from "./schedule";

type ModalState =
  | null
  | {
      mode: "create" | "edit";
      cycleId?: number;
      defaultStartDate?: string;
      defaultStartHour?: number;
      defaultEndDate?: string;
      defaultEndHour?: number;
    };

type InteractionMode = "drag" | "resize-start" | "resize-end";

type InteractionState = {
  mode: InteractionMode;
  pointerId: number;
  cycleId: number;
  startX: number;
  originalStartSlot: number;
  originalEndSlot: number;
};

type ConfigState = {
  productos: string[];
  colores: string[];
  ccts: string[];
  bbts: string[];
  lineasEnvasado: string[];
};

type UsageMaps = {
  productos: Record<string, number>;
  colores: Record<string, number>;
  ccts: Record<string, number>;
  bbts: Record<string, number>;
  lineasEnvasado: Record<string, number>;
};

type JumpTarget = {
  weekStart: string;
  day: number;
  hour: number;
};

type NoticeState = null | {
  message: string;
  tone: "info" | "success";
};

type TabKey = "plan" | "analysis" | "admin" | "instructions";
type PlanViewKey = "week" | "day";

/** Guardado solo en el navegador (sin autenticacion / sin backend obligatorio). */
const PLAN_LOCAL_STORAGE_KEY = "gantt-filtracion-plan-v1";
const GANTT_ROW_HEIGHT = 120;
const HOUR_WIDTH_BASE = 56;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.2;
const END_HOUR_OPTIONS = [...HOURS, 24];
const DEFAULT_CCTS = Array.from({ length: 27 }, (_, index) => `CCT ${index + 1}`);
const DEFAULT_BBTS = Array.from({ length: 10 }, (_, index) => `BBT ${index + 1}`);
const DEFAULT_LINEAS_ENVASADO = ["L3 - LATAS", "L4 - ONE WAY", "L5 - RGB"];

const DEFAULT_CONFIG: ConfigState = {
  productos: ["Lager", "Pilsener", "Aguila", "Poker"],
  colores: ["#3b82f6", "#16a34a", "#ea580c", "#dc2626", "#9333ea"],
  ccts: DEFAULT_CCTS,
  bbts: DEFAULT_BBTS,
  lineasEnvasado: DEFAULT_LINEAS_ENVASADO,
};

const appBg = "#f3f6fb";
const panelBg = "#ffffff";
const border = "#d8e1ec";
const text = "#243447";
const textSoft = "#5b6b7f";
const primary = "#1f6feb";
const primarySoft = "#e8f1ff";
const successSoft = "#ecfdf3";
const successText = "#027a48";
const danger = "#b91c1c";

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function parseQuantity(value: string) {
  const normalized = value.replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat("es-CO", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function normalizeStringList(values: string[]) {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

function readStringArrayOrNull(value: unknown) {
  if (!Array.isArray(value)) return null;
  return normalizeStringList(value.filter((item): item is string => typeof item === "string"));
}

function readPlanFromBrowserStorage(): {
  cycles: Cycle[];
  config: ConfigState;
  activeWeekStart: string;
} | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(PLAN_LOCAL_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as {
      cycles?: Record<string, unknown>[];
      config?: Partial<ConfigState>;
      activeWeekStart?: string;
    };

    const storedCycles = Array.isArray(parsed.cycles)
      ? sortCycles(parsed.cycles.map((cycle) => hydrateCycle(cycle)))
      : [];

    const storedWeekStart =
      typeof parsed.activeWeekStart === "string"
        ? getStartOfWeek(parsed.activeWeekStart)
        : getStartOfWeek(new Date());

    return {
      cycles: storedCycles,
      config: buildConfigState(parsed.config ?? undefined),
      activeWeekStart: storedWeekStart,
    };
  } catch {
    return null;
  }
}

function createCycleFillTarget(
  overrides?: Partial<CycleFillTarget>,
  fallbackRange?: Partial<Pick<CycleFillTarget, "startDate" | "startHour" | "endDate" | "endHour">>
): CycleFillTarget {
  const id = typeof overrides?.id === "string" ? overrides.id.trim() : "";
  const fallbackStartDate = fallbackRange?.startDate ?? toDateInputValue(new Date());
  const fallbackStartHour = sanitizeStartHour(fallbackRange?.startHour, 6);
  const fallbackEndRange = rangeFromSlots(
    slotFromDateHour(fallbackStartDate, fallbackStartHour),
    slotFromDateHour(fallbackStartDate, fallbackStartHour) + 1
  );
  const fallbackEndDate = fallbackRange?.endDate ?? fallbackEndRange.endDate;
  const fallbackEndHour = sanitizeEndHour(fallbackRange?.endHour, fallbackEndRange.endHour);

  const startDate = typeof overrides?.startDate === "string" ? overrides.startDate : fallbackStartDate;
  const startHour = sanitizeStartHour(overrides?.startHour, fallbackStartHour);
  const endDate = typeof overrides?.endDate === "string" ? overrides.endDate : fallbackEndDate;
  const endHour = sanitizeEndHour(overrides?.endHour, fallbackEndHour);
  const startSlot = slotFromDateHour(startDate, startHour);
  const endSlot = slotFromDateHour(endDate, endHour);
  const normalizedRange = endSlot > startSlot
    ? { startDate, startHour, endDate, endHour }
    : rangeFromSlots(startSlot, startSlot + 1);

  return {
    id: id || `fill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    cct: typeof overrides?.cct === "string" ? overrides.cct.trim() : "",
    bbt: typeof overrides?.bbt === "string" ? overrides.bbt.trim() : "",
    cantidadHl: typeof overrides?.cantidadHl === "string" ? overrides.cantidadHl.trim() : "",
    lineas: normalizeStringList(overrides?.lineas ?? []),
    ...normalizedRange,
  };
}

function sanitizeCycleFillTargets(
  value: unknown,
  fallbackRange?: Pick<CycleDraft, "startDate" | "startHour" | "endDate" | "endHour">
) {
  if (!Array.isArray(value)) return [];

  let fallbackStartSlot = fallbackRange ? slotFromDateHour(fallbackRange.startDate, fallbackRange.startHour) : null;

  return value
    .filter((item): item is Partial<CycleFillTarget> => typeof item === "object" && item !== null)
    .map((item) => {
      const fallback = fallbackStartSlot === null ? undefined : rangeFromSlots(fallbackStartSlot, fallbackStartSlot + 1);
      const fill = createCycleFillTarget(item, fallback);

      fallbackStartSlot = getFillBounds(fill).endSlot;
      return fill;
    });
}

function getMeaningfulCycleFillTargets(fills: CycleFillTarget[]) {
  return fills.filter((fill) => fill.cct || fill.bbt || fill.cantidadHl || fill.lineas.length > 0);
}

function getCycleFillSummary(fills: CycleFillTarget[]) {
  const meaningfulFills = getMeaningfulCycleFillTargets(fills);
  const totalHl = meaningfulFills.reduce((total, fill) => total + parseQuantity(fill.cantidadHl), 0);

  return {
    ccts: normalizeStringList(meaningfulFills.map((fill) => fill.cct)).join(", "),
    bbts: normalizeStringList(meaningfulFills.map((fill) => fill.bbt)).join(", "),
    cantidadHl: totalHl > 0 ? String(Number(totalHl.toFixed(1))) : "",
    lineaEnvasado: normalizeStringList(meaningfulFills.flatMap((fill) => fill.lineas)).join(", "),
  };
}

function formatCycleFillDetails(fills: CycleFillTarget[]) {
  return getMeaningfulCycleFillTargets(fills)
    .map((fill, index) => {
      const fillRange = `${formatDateTimeLabel(fill.startDate, fill.startHour)} -> ${formatDateTimeLabel(
        fill.endDate,
        fill.endHour
      )}`;
      const duration = getFillDurationHours(fill);

      return `${index + 1}. ${fill.cct || "Sin CCT"} -> ${fill.bbt || "Sin BBT"} -> ${
        fill.lineas.length > 0 ? fill.lineas.join(", ") : "Sin lineas"
      } | ${fill.cantidadHl ? `${fill.cantidadHl} hl` : "Sin cantidad"} | ${fillRange} (${duration}h)`;
    })
    .join(" | ");
}

function syncCycleFillFields(cycle: CycleDraft, options?: { preserveEmptyRows?: boolean }): CycleDraft {
  const sanitizedFills = sanitizeCycleFillTargets(cycle.llenados, cycle);
  const meaningfulFills = getMeaningfulCycleFillTargets(sanitizedFills);
  const fills =
    options?.preserveEmptyRows
      ? sanitizedFills
      : meaningfulFills;
  const summary = getCycleFillSummary(sanitizedFills);
  const nextRange = getCycleRangeIncludingFills(cycle, meaningfulFills);

  return {
    ...cycle,
    ...nextRange,
    llenados: fills,
    ccts: summary.ccts,
    bbts: summary.bbts,
    cantidadHl: summary.cantidadHl,
    lineaEnvasado: summary.lineaEnvasado,
  };
}

function getCycleRangeIncludingFills(
  cycle: Pick<CycleDraft, "startDate" | "startHour" | "endDate" | "endHour">,
  fills: CycleFillTarget[]
) {
  let { startSlot, endSlot } = getCycleBounds(cycle);

  fills.forEach((fill) => {
    const fillBounds = getFillBounds(fill);
    startSlot = Math.min(startSlot, fillBounds.startSlot);
    endSlot = Math.max(endSlot, fillBounds.endSlot);
  });

  return rangeFromSlots(startSlot, endSlot);
}

function ensureCycleCoversFills<T extends Pick<CycleDraft, "startDate" | "startHour" | "endDate" | "endHour" | "llenados">>(
  cycle: T
): T {
  return {
    ...cycle,
    ...getCycleRangeIncludingFills(cycle, getMeaningfulCycleFillTargets(cycle.llenados)),
  };
}

/** Recorta un llenado al rango [cycleStartSlot, cycleEndSlot) en slots absolutos. */
function clipFillToCycleRange(fill: CycleFillTarget, cycleStartSlot: number, cycleEndSlot: number): CycleFillTarget {
  const fb = getFillBounds(fill);
  const nextStart = Math.max(fb.startSlot, cycleStartSlot);
  const nextEnd = Math.min(fb.endSlot, cycleEndSlot);

  if (nextStart < nextEnd) {
    return applyRangeToFill(fill, nextStart, nextEnd);
  }

  const tuck = Math.max(cycleStartSlot, Math.min(cycleEndSlot - 1, fb.startSlot));
  const tuckEnd = Math.min(tuck + 1, cycleEndSlot);
  return applyRangeToFill(fill, tuck, Math.max(tuckEnd, tuck + 1));
}

/** Al arrastrar el borde izquierdo del ciclo, los llenados se mueven igual que el bloque (como en shiftCycle). */
function resizeCycleStartWithShifts(cycle: Cycle, newStartSlot: number): Cycle {
  const { startSlot, endSlot } = getCycleBounds(cycle);
  const clampedStart = Math.max(0, Math.min(newStartSlot, endSlot - 1));
  const delta = clampedStart - startSlot;

  const next: Cycle = {
    ...applyRangeToCycle(cycle, clampedStart, endSlot),
    llenados: cycle.llenados.map((fill) => shiftFill(fill, delta)),
  };

  return syncCycleFillFields(next) as Cycle;
}

/** Al arrastrar el borde derecho: recorta o extiende llenados para coincidir con el nuevo fin del ciclo. */
function resizeCycleEndWithFills(cycle: Cycle, newEndSlot: number): Cycle {
  const { startSlot } = getCycleBounds(cycle);
  const clampedEnd = Math.max(startSlot + 1, newEndSlot);

  let updatedFills = cycle.llenados.map((fill) => clipFillToCycleRange(fill, startSlot, clampedEnd));

  const meaningful = getMeaningfulCycleFillTargets(updatedFills);
  if (meaningful.length > 0) {
    const lastFill = meaningful[meaningful.length - 1];
    const lb = getFillBounds(lastFill);
    if (clampedEnd > lb.endSlot) {
      updatedFills = updatedFills.map((fill) =>
        fill.id === lastFill.id ? applyRangeToFill(lastFill, lb.startSlot, clampedEnd) : fill
      );
    }
  }

  let next: Cycle = {
    ...cycle,
    ...rangeFromSlots(startSlot, clampedEnd),
    llenados: updatedFills,
  };

  next = syncCycleFillFields(next) as Cycle;
  return ensureCycleCoversFills(next) as Cycle;
}

function getHydratedCycleFillTargets(
  raw: Record<string, unknown>,
  fallbackRange: Pick<CycleDraft, "startDate" | "startHour" | "endDate" | "endHour">
) {
  const storedFills = sanitizeCycleFillTargets(raw.llenados, fallbackRange);
  const legacyBbt = typeof raw.bbts === "string" ? raw.bbts.trim() : "";
  const legacyCct = typeof raw.ccts === "string" ? raw.ccts.trim() : "";
  const legacyCantidadHl = typeof raw.cantidadHl === "string" ? raw.cantidadHl.trim() : "";
  const legacyLinea = typeof raw.lineaEnvasado === "string" ? raw.lineaEnvasado.trim() : "";

  if (storedFills.length > 0) {
    const hasStoredCct = storedFills.some((fill) => fill.cct);
    const hasStoredCantidad = storedFills.some((fill) => fill.cantidadHl);

    return storedFills.map((fill, index) =>
      createCycleFillTarget({
        ...fill,
        cct: fill.cct || (!hasStoredCct ? legacyCct : ""),
        cantidadHl: fill.cantidadHl || (!hasStoredCantidad && index === 0 ? legacyCantidadHl : ""),
      })
    );
  }

  if (!legacyBbt && !legacyLinea) return [];

  return [
    createCycleFillTarget({
      cct: legacyCct,
      bbt: legacyBbt,
      cantidadHl: legacyCantidadHl,
      lineas: legacyLinea ? [legacyLinea] : [],
    }, fallbackRange),
  ];

}

function getSelectOptions(options: string[], currentValue: string) {
  return normalizeStringList(currentValue ? [currentValue, ...options] : options);
}

function buildConfigState(config?: Partial<ConfigState>): ConfigState {
  const productos = readStringArrayOrNull(config?.productos);
  const colores = readStringArrayOrNull(config?.colores);
  const ccts = readStringArrayOrNull(config?.ccts);
  const bbts = readStringArrayOrNull(config?.bbts);
  const lineas = readStringArrayOrNull(config?.lineasEnvasado);

  return {
    productos: productos && productos.length > 0 ? productos : DEFAULT_CONFIG.productos,
    colores: colores && colores.length > 0 ? colores : DEFAULT_CONFIG.colores,
    ccts: ccts ?? DEFAULT_CONFIG.ccts,
    bbts: bbts ?? DEFAULT_CONFIG.bbts,
    lineasEnvasado: lineas ?? DEFAULT_CONFIG.lineasEnvasado,
  };
}

function sanitizeStartHour(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 23
    ? value
    : fallback;
}

function sanitizeEndHour(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 24
    ? value
    : fallback;
}

function hydrateCycle(raw: Record<string, unknown>): Cycle {
  const fallbackStartDate = toDateInputValue(new Date());
  const legacyWeekStart = typeof raw.weekStart === "string" ? raw.weekStart : getStartOfWeek(new Date());
  const legacyDayIndex = typeof raw.dia === "number" ? clamp(raw.dia, 0, 6) : 0;
  const legacyStartDate = addDays(legacyWeekStart, legacyDayIndex);

  const startDate = typeof raw.startDate === "string" ? raw.startDate : legacyStartDate || fallbackStartDate;
  const startHour = sanitizeStartHour(raw.startHour ?? raw.horaInicio, 6);
  const startSlot = slotFromDateHour(startDate, startHour);

  const rawEndDate = typeof raw.endDate === "string" ? raw.endDate : startDate;
  const rawEndHour = sanitizeEndHour(raw.endHour ?? raw.horaFin, Math.min(startHour + 2, 24));
  const endSlotCandidate = slotFromDateHour(rawEndDate, rawEndHour);
  const endSlot = endSlotCandidate > startSlot ? endSlotCandidate : startSlot + 1;
  const normalizedRange = rangeFromSlots(startSlot, endSlot);
  const llenados = getHydratedCycleFillTargets(raw, normalizedRange);
  const fillSummary = getCycleFillSummary(llenados);
  const finalRange = getCycleRangeIncludingFills(normalizedRange, getMeaningfulCycleFillTargets(llenados));

  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    ...finalRange,
    producto: typeof raw.producto === "string" ? raw.producto : "",
    color: typeof raw.color === "string" ? raw.color : "#3b82f6",
    aseo: Boolean(raw.aseo),
    ccts: fillSummary.ccts,
    llenados,
    bbts: fillSummary.bbts,
    cantidadHl: fillSummary.cantidadHl,
    lineaEnvasado: fillSummary.lineaEnvasado,
    mezcla: Boolean(raw.mezcla),
    origenMezclaTipo:
      raw.origenMezclaTipo === "bbt" || raw.origenMezclaTipo === "cct" ? raw.origenMezclaTipo : "",
    origenMezcla: typeof raw.origenMezcla === "string" ? raw.origenMezcla : "",
    proporcionMezcla: typeof raw.proporcionMezcla === "string" ? raw.proporcionMezcla : "",
    mantenimientoProgramado: Boolean(raw.mantenimientoProgramado),
    mantenimientoCorrectivo: Boolean(raw.mantenimientoCorrectivo),
    notas: typeof raw.notas === "string" ? raw.notas : "",
  };
}

function formatOrigenMezcla(cycle: Pick<Cycle, "mezcla" | "origenMezclaTipo" | "origenMezcla">) {
  if (!cycle.mezcla || !cycle.origenMezclaTipo || !cycle.origenMezcla) return "";

  return cycle.origenMezclaTipo === "bbt"
    ? `BBT (refiltrar): ${cycle.origenMezcla}`
    : `CCT: ${cycle.origenMezcla}`;
}

function isMaintenanceEvent(
  cycle: Pick<CycleDraft, "mantenimientoProgramado" | "mantenimientoCorrectivo">
) {
  return cycle.mantenimientoProgramado || cycle.mantenimientoCorrectivo;
}

function isSpecialEventCycle(
  cycle: Pick<CycleDraft, "aseo" | "mantenimientoProgramado" | "mantenimientoCorrectivo">
) {
  return cycle.aseo || isMaintenanceEvent(cycle);
}

function getMaintenanceEventLabel(
  cycle: Pick<CycleDraft, "mantenimientoProgramado" | "mantenimientoCorrectivo">
) {
  if (cycle.mantenimientoProgramado && cycle.mantenimientoCorrectivo) {
    return "Mantenimiento preventivo / correctivo";
  }

  if (cycle.mantenimientoProgramado) return "Mantenimiento preventivo";
  if (cycle.mantenimientoCorrectivo) return "Mantenimiento correctivo";
  return "";
}

function getCycleDisplayName(
  cycle: Pick<CycleDraft, "aseo" | "mantenimientoProgramado" | "mantenimientoCorrectivo" | "producto">
) {
  const maintenanceLabel = getMaintenanceEventLabel(cycle);
  if (maintenanceLabel) return maintenanceLabel;
  if (cycle.aseo) return "ASEO";
  return cycle.producto || "Sin producto";
}

function createEmptyCycle(
  config: ConfigState,
  defaults?: Partial<Pick<CycleDraft, "startDate" | "startHour" | "endDate" | "endHour">>
): CycleDraft {
  const startDate = defaults?.startDate ?? toDateInputValue(new Date());
  const startHour = defaults?.startHour ?? 6;
  const fallbackRange = rangeFromSlots(slotFromDateHour(startDate, startHour), slotFromDateHour(startDate, startHour) + 2);

  return {
    startDate,
    startHour,
    endDate: defaults?.endDate ?? fallbackRange.endDate,
    endHour: defaults?.endHour ?? fallbackRange.endHour,
    producto: config.productos[0] || "",
    color: config.colores[0] || "#3b82f6",
    aseo: false,
    ccts: "",
    llenados: [createCycleFillTarget(undefined, fallbackRange)],
    bbts: "",
    cantidadHl: "",
    lineaEnvasado: "",
    mezcla: false,
    origenMezclaTipo: "",
    origenMezcla: "",
    proporcionMezcla: "",
    mantenimientoProgramado: false,
    mantenimientoCorrectivo: false,
    notas: "",
  };
}

function validateCycle(cycle: CycleDraft) {
  if (cycle.startHour < 0 || cycle.startHour > 23) return "La hora de inicio es invalida.";
  if (cycle.endHour < 0 || cycle.endHour > 24) return "La hora de fin es invalida.";

  const { startSlot, endSlot } = getCycleBounds(cycle);
  if (endSlot <= startSlot) return "La fecha y hora de fin deben ser mayores al inicio.";

  if (!isSpecialEventCycle(cycle) && !cycle.producto.trim()) {
    return "Producto requerido.";
  }

  if (cycle.aseo && !cycle.notas.trim()) {
    return "Describe en notas lo que se realizara en el aseo.";
  }

  if (isMaintenanceEvent(cycle) && !cycle.notas.trim()) {
    return "Describe en notas lo que se realizara en el mantenimiento.";
  }

  const meaningfulFills = getMeaningfulCycleFillTargets(cycle.llenados);

  if (!isSpecialEventCycle(cycle)) {
    if (meaningfulFills.length === 0) {
      return "Agrega al menos un BBT a llenar.";
    }

    if (meaningfulFills.some((fill) => !fill.bbt)) {
      return "Cada llenado debe tener un BBT seleccionado.";
    }

    if (meaningfulFills.some((fill) => !fill.cct)) {
      return "Cada llenado debe tener un CCT origen seleccionado.";
    }

    if (meaningfulFills.some((fill) => parseQuantity(fill.cantidadHl) <= 0)) {
      return "Cada BBT debe tener una cantidad mayor a cero.";
    }

    if (meaningfulFills.some((fill) => fill.lineas.length === 0)) {
      return "Cada BBT debe estar enlazado al menos a una linea.";
    }

    let previousFillEndSlot: number | null = null;
    const cycleBounds = getCycleBounds(cycle);

    for (const [index, fill] of meaningfulFills.entries()) {
      const fillBounds = getFillBounds(fill);

      if (fillBounds.endSlot <= fillBounds.startSlot) {
        return `El llenado ${index + 1} debe tener una hora final mayor al inicio.`;
      }

      if (fillBounds.startSlot < cycleBounds.startSlot || fillBounds.endSlot > cycleBounds.endSlot) {
        return `El llenado ${index + 1} debe quedar dentro del rango del ciclo.`;
      }

      if (previousFillEndSlot !== null && fillBounds.startSlot < previousFillEndSlot) {
        return `El llenado ${index + 1} debe iniciar despues de que termine el llenado anterior.`;
      }

      previousFillEndSlot = fillBounds.endSlot;
    }
  }

  if (!isSpecialEventCycle(cycle) && cycle.mezcla) {
    if (!cycle.origenMezclaTipo) return "Selecciona si la mezcla viene de BBT o CCT.";
    if (!cycle.origenMezcla.trim()) return "Selecciona el origen de la mezcla.";
    if (!cycle.proporcionMezcla.trim()) return "La proporcion de mezcla es requerida.";
  }

  return null;
}

function formatDateTimeLabel(date: string, hour: number) {
  return `${formatDateLabel(date)} ${hour === 24 ? "24:00" : formatHour(hour)}`;
}

function formatHourOption(hour: number) {
  return hour === 24 ? "24:00" : formatHour(hour);
}

function formatCycleTooltip(cycle: Cycle) {
  const duration = getCycleDurationHours(cycle);
  const lines = [
    getCycleDisplayName(cycle),
    `Inicio: ${formatDateTimeLabel(cycle.startDate, cycle.startHour)}`,
    `Fin: ${formatDateTimeLabel(cycle.endDate, cycle.endHour)}`,
    `Duracion: ${duration}h`,
  ];

  if (!isSpecialEventCycle(cycle)) {
    if (cycle.ccts) lines.push(`CCTs: ${cycle.ccts}`);
    if (cycle.bbts) lines.push(`BBTs: ${cycle.bbts}`);
    if (cycle.cantidadHl) lines.push(`Cantidad: ${cycle.cantidadHl} hl`);
    if (cycle.lineaEnvasado) lines.push(`Lineas de envasado: ${cycle.lineaEnvasado}`);
    if (formatCycleFillDetails(cycle.llenados)) lines.push(`Detalle llenado: ${formatCycleFillDetails(cycle.llenados)}`);
    if (cycle.mezcla) lines.push("Mezcla: Si");
    if (formatOrigenMezcla(cycle)) lines.push(`Origen mezcla: ${formatOrigenMezcla(cycle)}`);
    if (cycle.proporcionMezcla) lines.push(`Proporcion: ${cycle.proporcionMezcla}`);
  }

  if (cycle.notas) lines.push(`Notas: ${cycle.notas}`);

  return lines.join("\n");
}

function formatFillTimeRange(fill: CycleFillTarget) {
  const endLabel = fill.endHour === 24 ? "24:00" : formatHour(fill.endHour);
  return `${formatHour(fill.startHour)}-${endLabel}`;
}

function getFillsOverlappingDaySegment(
  cycle: Cycle,
  dayDate: string,
  segment: { startHour: number; endHour: number }
) {
  if (isSpecialEventCycle(cycle)) return [];

  const meaningful = getMeaningfulCycleFillTargets(cycle.llenados);
  const dayStartSlot = slotFromDateHour(dayDate, 0);
  const segmentStartSlot = dayStartSlot + segment.startHour;
  const segmentEndSlot = dayStartSlot + segment.endHour;

  return meaningful.filter((fill) => {
    const fillBounds = getFillBounds(fill);
    return fillBounds.endSlot > segmentStartSlot && fillBounds.startSlot < segmentEndSlot;
  });
}

function incrementUsage(map: Record<string, number>, value: string) {
  const normalized = value.trim();
  if (!normalized) return;
  map[normalized] = (map[normalized] || 0) + 1;
}

function buildUsageMaps(cycles: Cycle[]): UsageMaps {
  const usageMaps: UsageMaps = {
    productos: {},
    colores: {},
    ccts: {},
    bbts: {},
    lineasEnvasado: {},
  };

  cycles.forEach((cycle) => {
    if (!isSpecialEventCycle(cycle)) {
      incrementUsage(usageMaps.productos, cycle.producto);
    }

    incrementUsage(usageMaps.colores, cycle.color);
    normalizeStringList(cycle.llenados.map((fill) => fill.cct)).forEach((item) => incrementUsage(usageMaps.ccts, item));
    normalizeStringList(cycle.llenados.map((fill) => fill.bbt)).forEach((item) => incrementUsage(usageMaps.bbts, item));
    normalizeStringList(cycle.llenados.flatMap((fill) => fill.lineas)).forEach((item) =>
      incrementUsage(usageMaps.lineasEnvasado, item)
    );

    if (cycle.mezcla && cycle.origenMezclaTipo === "cct") {
      incrementUsage(usageMaps.ccts, cycle.origenMezcla);
    }

    if (cycle.mezcla && cycle.origenMezclaTipo === "bbt") {
      incrementUsage(usageMaps.bbts, cycle.origenMezcla);
    }
  });

  return usageMaps;
}

function getCycleIssues(cycle: Cycle) {
  const issues: string[] = [];
  const duration = getCycleDurationHours(cycle);

  if (duration <= 0) issues.push("Rango horario invalido.");

  if (cycle.aseo) {
    if (!cycle.notas.trim()) issues.push("Sin detalle del aseo.");
  } else if (isMaintenanceEvent(cycle)) {
    if (!cycle.notas.trim()) issues.push("Sin detalle del mantenimiento.");
  } else {
    if (!cycle.producto.trim()) issues.push("Sin producto.");
    if (!cycle.ccts.trim()) issues.push("Sin CCT asignado.");
    if (getMeaningfulCycleFillTargets(cycle.llenados).length === 0) issues.push("Sin BBT asignado.");
    if (cycle.llenados.some((fill) => !fill.cct.trim() && (fill.bbt.trim() || fill.cantidadHl.trim() || fill.lineas.length > 0))) {
      issues.push("Hay llenados sin CCT origen.");
    }
    if (cycle.llenados.some((fill) => fill.bbt.trim() && parseQuantity(fill.cantidadHl) <= 0)) {
      issues.push("Hay BBTs sin cantidad valida.");
    }
    if (cycle.llenados.some((fill) => fill.bbt.trim() && fill.lineas.length === 0)) {
      issues.push("Hay BBTs sin lineas asociadas.");
    }
    if (cycle.llenados.some((fill) => !fill.bbt.trim() && fill.lineas.length > 0)) {
      issues.push("Hay lineas sin BBT asociado.");
    }
    if (
      getMeaningfulCycleFillTargets(cycle.llenados).some((fill) => {
        const fillBounds = getFillBounds(fill);
        return fillBounds.endSlot <= fillBounds.startSlot;
      })
    ) {
      issues.push("Hay llenados con rango horario invalido.");
    }
    if (
      getMeaningfulCycleFillTargets(cycle.llenados).some((fill) => {
        const cycleBounds = getCycleBounds(cycle);
        const fillBounds = getFillBounds(fill);
        return fillBounds.startSlot < cycleBounds.startSlot || fillBounds.endSlot > cycleBounds.endSlot;
      })
    ) {
      issues.push("Hay llenados fuera del rango del ciclo.");
    }
    const orderedFills = getMeaningfulCycleFillTargets(cycle.llenados);
    if (
      orderedFills.some((fill, index) => {
        if (index === 0) return false;
        return getFillBounds(fill).startSlot < getFillBounds(orderedFills[index - 1]).endSlot;
      })
    ) {
      issues.push("Hay llenados fuera de orden horario.");
    }
    if (!cycle.cantidadHl.trim()) issues.push("Sin cantidad (hl).");
    if (!cycle.lineaEnvasado.trim()) issues.push("Sin linea de envasado.");
  }

  if (!isSpecialEventCycle(cycle) && cycle.mezcla) {
    if (!cycle.origenMezclaTipo) issues.push("Mezcla sin tipo de origen.");
    if (!cycle.origenMezcla.trim()) issues.push("Mezcla sin origen seleccionado.");
    if (!cycle.proporcionMezcla.trim()) issues.push("Mezcla sin proporcion.");
  }

  return issues;
}

function buttonStyle(active = false): React.CSSProperties {
  return {
    background: active ? primary : "#fff",
    color: active ? "#fff" : text,
    border: `1px solid ${active ? primary : border}`,
    borderRadius: 10,
    padding: "10px 14px",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  };
}

function cardStyle(): React.CSSProperties {
  return {
    background: panelBg,
    border: `1px solid ${border}`,
    borderRadius: 16,
    boxShadow: "0 10px 30px rgba(15,23,42,0.08)",
  };
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: `1px solid ${border}`,
  fontSize: 13,
  boxSizing: "border-box",
  marginTop: 6,
};

function StatsBar({ cycles }: { cycles: Cycle[] }) {
  const totalHoras = cycles.reduce((accumulator, cycle) => accumulator + getCycleDurationHours(cycle), 0);
  const totalHl = cycles.reduce((accumulator, cycle) => accumulator + parseQuantity(cycle.cantidadHl), 0);
  const aseos = cycles.filter((cycle) => cycle.aseo).length;
  const productos = [
    ...new Set(
      cycles
        .filter((cycle) => !isSpecialEventCycle(cycle) && cycle.producto)
        .map((cycle) => cycle.producto)
    ),
  ];

  return (
    <div
      style={{
        ...cardStyle(),
        padding: 16,
        marginBottom: 16,
        display: "flex",
        gap: 14,
        flexWrap: "wrap",
      }}
    >
      {[
        { label: "CICLOS", value: cycles.length },
        { label: "HORAS", value: `${totalHoras}h` },
        { label: "HL", value: `${formatQuantity(totalHl)} hl` },
        { label: "ASEOS", value: aseos },
        { label: "PRODUCTOS", value: productos.length },
      ].map((item) => (
        <div
          key={item.label}
          style={{
            minWidth: 120,
            padding: "10px 14px",
            borderRadius: 12,
            background: "#f8fbff",
            border: `1px solid ${border}`,
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 700 }}>{item.value}</div>
          <div style={{ fontSize: 11, color: textSoft }}>{item.label}</div>
        </div>
      ))}
    </div>
  );
}

function CycleModal({
  openState,
  cycles,
  activeWeekStart,
  config,
  onClose,
  onSave,
  onDelete,
  onDuplicate,
}: {
  openState: ModalState;
  cycles: Cycle[];
  activeWeekStart: string;
  config: ConfigState;
  onClose: () => void;
  onSave: (data: CycleDraft, cycleId?: number) => void;
  onDelete: (cycleId: number) => void;
  onDuplicate: (cycleId: number) => void;
}) {
  const existing =
    openState && openState.mode === "edit"
      ? cycles.find((cycle) => cycle.id === openState.cycleId) || null
      : null;

  const [form, setForm] = useState<CycleDraft>(() => createEmptyCycle(config));
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    setSaveError("");
    if (!openState) return;

    if (existing) {
      setForm(
        syncCycleFillFields(
          {
            startDate: existing.startDate,
            startHour: existing.startHour,
            endDate: existing.endDate,
            endHour: existing.endHour,
            producto: existing.producto,
            color: existing.color,
            aseo: existing.aseo,
            ccts: existing.ccts,
            llenados:
              existing.llenados.length > 0
                ? existing.llenados.map((fill) => createCycleFillTarget(fill))
                : [createCycleFillTarget(undefined, existing)],
            bbts: existing.bbts,
            cantidadHl: existing.cantidadHl,
            lineaEnvasado: existing.lineaEnvasado,
            mezcla: existing.mezcla,
            origenMezclaTipo: existing.origenMezclaTipo,
            origenMezcla: existing.origenMezcla,
            proporcionMezcla: existing.proporcionMezcla,
            mantenimientoProgramado: existing.mantenimientoProgramado,
            mantenimientoCorrectivo: existing.mantenimientoCorrectivo,
            notas: existing.notas,
          },
          { preserveEmptyRows: true }
        )
      );
    } else {
      setForm(
        createEmptyCycle(config, {
          startDate: openState.defaultStartDate,
          startHour: openState.defaultStartHour,
          endDate: openState.defaultEndDate,
          endHour: openState.defaultEndHour,
        })
      );
    }
  }, [openState, existing, config]);

  useEffect(() => {
    setSaveError("");
  }, [form]);

  if (!openState) return null;

  const setField = <K extends keyof CycleDraft>(key: K, value: CycleDraft[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const setFillRows = (fills: CycleFillTarget[]) => {
    setForm((previous) => syncCycleFillFields({ ...previous, llenados: fills }, { preserveEmptyRows: true }));
  };

  const updateFillRow = (fillId: string, patch: Partial<CycleFillTarget>) => {
    setFillRows(
      form.llenados.map((fill) =>
        fill.id === fillId
          ? createCycleFillTarget({
              ...fill,
              ...patch,
              lineas: patch.lineas ?? fill.lineas,
            })
          : fill
      )
    );
  };

  const updateFillRange = (
    fillId: string,
    patch: Partial<Pick<CycleFillTarget, "startDate" | "startHour" | "endDate" | "endHour">>
  ) => {
    updateFillRow(fillId, patch);
  };

  const addFillRow = () => {
    const cycleStartSlot = slotFromDateHour(form.startDate, form.startHour);
    const nextStartSlot = form.llenados.reduce(
      (latestSlot, fill) => Math.max(latestSlot, getFillBounds(fill).endSlot),
      cycleStartSlot
    );

    setFillRows([...form.llenados, createCycleFillTarget(undefined, rangeFromSlots(nextStartSlot, nextStartSlot + 1))]);
  };

  const removeFillRow = (fillId: string) => {
    const remaining = form.llenados.filter((fill) => fill.id !== fillId);
    setFillRows(remaining.length > 0 ? remaining : [createCycleFillTarget(undefined, form)]);
  };

  const moveFillRow = (fillId: string, direction: -1 | 1) => {
    const currentIndex = form.llenados.findIndex((fill) => fill.id === fillId);
    const targetIndex = currentIndex + direction;

    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= form.llenados.length) return;

    const orderedRanges = form.llenados.map((fill) => ({
      startDate: fill.startDate,
      startHour: fill.startHour,
      endDate: fill.endDate,
      endHour: fill.endHour,
    }));
    const nextFills = [...form.llenados];
    const [movedFill] = nextFills.splice(currentIndex, 1);
    nextFills.splice(targetIndex, 0, movedFill);
    setFillRows(nextFills.map((fill, index) => createCycleFillTarget({ ...fill, ...orderedRanges[index] })));
  };

  const toggleFillLine = (fillId: string, line: string) => {
    const target = form.llenados.find((fill) => fill.id === fillId);
    if (!target) return;

    const nextLines = target.lineas.includes(line)
      ? target.lineas.filter((item) => item !== line)
      : [...target.lineas, line];

    updateFillRow(fillId, { lineas: nextLines });
  };

  const updateRange = (patch: Partial<Pick<CycleDraft, "startDate" | "startHour" | "endDate" | "endHour">>) => {
    setForm((previous) => {
      const next = { ...previous, ...patch };
      const { startSlot, endSlot } = getCycleBounds(next);

      if (endSlot <= startSlot) {
        const adjusted = rangeFromSlots(startSlot, startSlot + 1);
        next.endDate = adjusted.endDate;
        next.endHour = adjusted.endHour;
      }

      return syncCycleFillFields(next, { preserveEmptyRows: true });
    });
  };

  const lineasOptions = normalizeStringList([...config.lineasEnvasado, ...form.llenados.flatMap((fill) => fill.lineas)]);
  const origenOptions = getSelectOptions(
    form.origenMezclaTipo === "bbt" ? config.bbts : config.ccts,
    form.origenMezcla
  );
  const specialEventActive = isSpecialEventCycle(form);
  const colorOptions = getSelectOptions(config.colores, form.color);
  const defaultProduct = config.productos[0] || "";
  const defaultColor = config.colores[0] || "#3b82f6";
  const duration = getCycleDurationHours(form);

  const handleAseo = (checked: boolean) => {
    setForm((previous) => ({
      ...previous,
      aseo: checked,
      mantenimientoProgramado: checked ? false : previous.mantenimientoProgramado,
      mantenimientoCorrectivo: checked ? false : previous.mantenimientoCorrectivo,
      producto: checked ? "ASEO" : defaultProduct,
      color: checked ? "#94a3b8" : defaultColor,
      ccts: checked ? "" : previous.ccts,
      llenados: checked ? [] : previous.llenados,
      bbts: checked ? "" : previous.bbts,
      cantidadHl: checked ? "" : previous.cantidadHl,
      lineaEnvasado: checked ? "" : previous.lineaEnvasado,
      mezcla: checked ? false : previous.mezcla,
      origenMezclaTipo: checked ? "" : previous.origenMezclaTipo,
      origenMezcla: checked ? "" : previous.origenMezcla,
      proporcionMezcla: checked ? "" : previous.proporcionMezcla,
    }));
  };

  const handleMaintenanceChange = (type: "preventivo" | "correctivo", checked: boolean) => {
    setForm((previous) => {
      const nextProgramado = type === "preventivo" ? checked : checked ? false : previous.mantenimientoProgramado;
      const nextCorrectivo = type === "correctivo" ? checked : checked ? false : previous.mantenimientoCorrectivo;
      const nextMaintenanceActive = nextProgramado || nextCorrectivo;

      return {
        ...previous,
        aseo: nextMaintenanceActive ? false : previous.aseo,
        mantenimientoProgramado: nextProgramado,
        mantenimientoCorrectivo: nextCorrectivo,
        producto: nextMaintenanceActive ? "" : defaultProduct,
        color: nextMaintenanceActive
          ? nextCorrectivo
            ? "#dc2626"
            : "#f59e0b"
          : defaultColor,
        ccts: nextMaintenanceActive ? "" : previous.ccts,
        llenados: nextMaintenanceActive ? [] : previous.llenados,
        bbts: nextMaintenanceActive ? "" : previous.bbts,
        cantidadHl: nextMaintenanceActive ? "" : previous.cantidadHl,
        lineaEnvasado: nextMaintenanceActive ? "" : previous.lineaEnvasado,
        mezcla: nextMaintenanceActive ? false : previous.mezcla,
        origenMezclaTipo: nextMaintenanceActive ? "" : previous.origenMezclaTipo,
        origenMezcla: nextMaintenanceActive ? "" : previous.origenMezcla,
        proporcionMezcla: nextMaintenanceActive ? "" : previous.proporcionMezcla,
      };
    });
  };

  const save = () => {
    const nextForm = syncCycleFillFields(form);
    const error = validateCycle(nextForm);
    if (error) {
      setSaveError(error);
      return;
    }

    setSaveError("");
    onSave(nextForm, existing?.id);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        zIndex: 999,
      }}
    >
      <div
        style={{
          ...cardStyle(),
          width: 720,
          maxWidth: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: 24,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 18,
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: text }}>
              {existing ? "Editar ciclo continuo" : "Nuevo ciclo continuo"}
            </div>
            <div style={{ fontSize: 12, color: textSoft }}>
              Semana visible: {formatWeekLabel(activeWeekStart)}
            </div>
          </div>
          <button onClick={onClose} style={{ ...buttonStyle(), padding: "6px 10px" }}>
            x
          </button>
        </div>

        <div
          style={{
            ...cardStyle(),
            padding: 14,
            marginBottom: 16,
            background: "#f8fbff",
          }}
        >
          <div style={{ fontSize: 12, color: textSoft, marginBottom: 6 }}>Rango del ciclo</div>
          <div style={{ fontWeight: 700 }}>
            {formatDateTimeLabel(form.startDate, form.startHour)} {"->"} {formatDateTimeLabel(form.endDate, form.endHour)}
          </div>
          <div style={{ fontSize: 12, color: textSoft, marginTop: 4 }}>Duracion: {duration}h</div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <div>
            <label style={{ fontSize: 12, color: textSoft }}>Fecha inicio</label>
            <input
              type="date"
              value={form.startDate}
              onChange={(event) => updateRange({ startDate: event.target.value })}
              style={inputStyle}
            />
          </div>

          <div>
            <label style={{ fontSize: 12, color: textSoft }}>Hora inicio</label>
            <select
              value={form.startHour}
              onChange={(event) => updateRange({ startHour: Number(event.target.value) })}
              style={inputStyle}
            >
              {HOURS.map((hour) => (
                <option key={hour} value={hour}>
                  {formatHour(hour)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ fontSize: 12, color: textSoft }}>Fecha fin</label>
            <input
              type="date"
              value={form.endDate}
              onChange={(event) => updateRange({ endDate: event.target.value })}
              style={inputStyle}
            />
          </div>

          <div>
            <label style={{ fontSize: 12, color: textSoft }}>Hora fin</label>
            <select
              value={form.endHour}
              onChange={(event) => updateRange({ endHour: Number(event.target.value) })}
              style={inputStyle}
            >
              {END_HOUR_OPTIONS.map((hour) => (
                <option key={hour} value={hour}>
                  {formatHourOption(hour)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 16, display: "flex", gap: 18, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={form.aseo}
              onChange={(event) => handleAseo(event.target.checked)}
            />
            ASEO
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={form.mantenimientoProgramado}
              onChange={(event) => handleMaintenanceChange("preventivo", event.target.checked)}
            />
            Mantenimiento preventivo
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={form.mantenimientoCorrectivo}
              onChange={(event) => handleMaintenanceChange("correctivo", event.target.checked)}
            />
            Mantenimiento correctivo
          </label>
        </div>

        {!specialEventActive && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, color: textSoft }}>Producto</label>
            <select
              value={form.producto}
              onChange={(event) => setField("producto", event.target.value)}
              style={inputStyle}
            >
              <option value="">Seleccionar...</option>
              {config.productos.map((product) => (
                <option key={product} value={product}>
                  {product}
                </option>
              ))}
            </select>
          </div>
        )}

        {!specialEventActive && (
          <>
            <div
              style={{
                ...cardStyle(),
                padding: 14,
                marginBottom: 16,
                background: "#f8fbff",
              }}
            >
              <div style={{ fontSize: 12, color: textSoft, marginBottom: 6 }}>Resumen operativo</div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
                <span>CCTs: {form.ccts || "Sin CCTs"}</span>
                <span>|</span>
                <span>Total: {form.cantidadHl ? `${form.cantidadHl} hl` : "Sin cantidad"}</span>
              </div>
            </div>

            <div
              style={{
                ...cardStyle(),
                padding: 16,
                marginBottom: 16,
                background: "#f8fbff",
              }}
            >
              <div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontSize: 12, color: textSoft }}>Llenados del ciclo</div>
                    <div style={{ fontSize: 13, marginTop: 4 }}>
                      Ordena los BBTs y asigna el rango de llenado de cada uno. Si un rango pasa el fin del ciclo, el ciclo se extiende.
                    </div>
                  </div>
                  <button type="button" onClick={addFillRow} style={buttonStyle()}>
                    Agregar BBT
                  </button>
                </div>

                <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
                  {form.llenados.map((fill, index) => {
                    const fillCctOptions = getSelectOptions(config.ccts, fill.cct);
                    const fillBbtOptions = getSelectOptions(config.bbts, fill.bbt);
                    const lineHelpText =
                      lineasOptions.length === 0
                        ? "No hay lineas configuradas en Admin."
                        : "Selecciona una o varias lineas para este BBT.";

                    return (
                      <div
                        key={fill.id}
                        style={{
                          border: `1px solid ${border}`,
                          borderRadius: 14,
                          padding: 14,
                          background: "#fff",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 12,
                            flexWrap: "wrap",
                            alignItems: "center",
                            marginBottom: 10,
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 700 }}>Orden {index + 1}</div>
                            <div style={{ fontSize: 12, color: textSoft, marginTop: 2 }}>
                              {getFillDurationHours(fill)}h de llenado
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <button
                              type="button"
                              onClick={() => moveFillRow(fill.id, -1)}
                              disabled={index === 0}
                              style={{
                                ...buttonStyle(),
                                padding: "6px 10px",
                                opacity: index === 0 ? 0.45 : 1,
                                cursor: index === 0 ? "not-allowed" : "pointer",
                              }}
                            >
                              Subir
                            </button>
                            <button
                              type="button"
                              onClick={() => moveFillRow(fill.id, 1)}
                              disabled={index === form.llenados.length - 1}
                              style={{
                                ...buttonStyle(),
                                padding: "6px 10px",
                                opacity: index === form.llenados.length - 1 ? 0.45 : 1,
                                cursor: index === form.llenados.length - 1 ? "not-allowed" : "pointer",
                              }}
                            >
                              Bajar
                            </button>
                            <button
                              type="button"
                              onClick={() => removeFillRow(fill.id)}
                              style={{
                                ...buttonStyle(),
                                color: danger,
                                border: `1px solid ${danger}`,
                                padding: "6px 10px",
                              }}
                            >
                              Quitar
                            </button>
                          </div>
                        </div>

                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                            gap: 10,
                          }}
                        >
                          <div>
                            <label style={{ fontSize: 12, color: textSoft }}>CCT origen</label>
                            <select
                              value={fill.cct}
                              onChange={(event) => updateFillRow(fill.id, { cct: event.target.value })}
                              style={inputStyle}
                            >
                              <option value="">Seleccionar...</option>
                              {fillCctOptions.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div>
                            <label style={{ fontSize: 12, color: textSoft }}>BBT a llenar</label>
                            <select
                              value={fill.bbt}
                              onChange={(event) => updateFillRow(fill.id, { bbt: event.target.value })}
                              style={inputStyle}
                            >
                              <option value="">Seleccionar...</option>
                              {fillBbtOptions.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div>
                            <label style={{ fontSize: 12, color: textSoft }}>Cantidad del BBT (hl)</label>
                            <input
                              type="number"
                              min={0}
                              step="0.1"
                              value={fill.cantidadHl}
                              onChange={(event) => updateFillRow(fill.id, { cantidadHl: event.target.value })}
                              placeholder="Ej: 120"
                              style={inputStyle}
                            />
                          </div>
                        </div>

                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                            gap: 10,
                            marginTop: 12,
                          }}
                        >
                          <div>
                            <label style={{ fontSize: 12, color: textSoft }}>Fecha inicio llenado</label>
                            <input
                              type="date"
                              value={fill.startDate}
                              onChange={(event) => updateFillRange(fill.id, { startDate: event.target.value })}
                              style={inputStyle}
                            />
                          </div>
                          <div>
                            <label style={{ fontSize: 12, color: textSoft }}>Hora inicio llenado</label>
                            <select
                              value={fill.startHour}
                              onChange={(event) => updateFillRange(fill.id, { startHour: Number(event.target.value) })}
                              style={inputStyle}
                            >
                              {HOURS.map((hour) => (
                                <option key={hour} value={hour}>
                                  {formatHour(hour)}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label style={{ fontSize: 12, color: textSoft }}>Fecha fin llenado</label>
                            <input
                              type="date"
                              value={fill.endDate}
                              onChange={(event) => updateFillRange(fill.id, { endDate: event.target.value })}
                              style={inputStyle}
                            />
                          </div>
                          <div>
                            <label style={{ fontSize: 12, color: textSoft }}>Hora fin llenado</label>
                            <select
                              value={fill.endHour}
                              onChange={(event) => updateFillRange(fill.id, { endHour: Number(event.target.value) })}
                              style={inputStyle}
                            >
                              {END_HOUR_OPTIONS.map((hour) => (
                                <option key={hour} value={hour}>
                                  {formatHourOption(hour)}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>

                        <div style={{ marginTop: 12 }}>
                          <div style={{ fontSize: 12, color: textSoft }}>Lineas asociadas</div>
                          <div style={{ fontSize: 12, color: textSoft, marginTop: 4 }}>{lineHelpText}</div>

                          {lineasOptions.length > 0 && (
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                              {lineasOptions.map((linea) => {
                                const checked = fill.lineas.includes(linea);

                                return (
                                  <label
                                    key={`${fill.id}-${linea}`}
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 8,
                                      padding: "8px 10px",
                                      borderRadius: 999,
                                      border: `1px solid ${checked ? primary : border}`,
                                      background: checked ? primarySoft : "#fff",
                                      cursor: "pointer",
                                      fontSize: 13,
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => toggleFillLine(fill.id, linea)}
                                    />
                                    {linea}
                                  </label>
                                );
                              })}
                            </div>
                          )}

                          {fill.lineas.length > 0 && (
                            <div style={{ fontSize: 12, color: textSoft, marginTop: 10 }}>
                              Lineas seleccionadas: {fill.lineas.join(", ")}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ fontSize: 12, color: textSoft, marginTop: 12 }}>
                  Resumen del ciclo: {form.ccts || "Sin CCTs"} {"|"} {form.bbts || "Sin BBTs"} {"|"}{" "}
                  {form.cantidadHl ? `${form.cantidadHl} hl` : "Sin cantidad"} {"|"}{" "}
                  {form.lineaEnvasado || "Sin lineas"}
                </div>
                <div style={{ fontSize: 12, color: textSoft, marginTop: 6 }}>
                  Secuencia: {formatCycleFillDetails(form.llenados) || "Sin rangos definidos"}
                </div>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={form.mezcla}
                  onChange={(event) =>
                    setForm((previous) => ({
                      ...previous,
                      mezcla: event.target.checked,
                      origenMezclaTipo: event.target.checked ? previous.origenMezclaTipo : "",
                      origenMezcla: event.target.checked ? previous.origenMezcla : "",
                      proporcionMezcla: event.target.checked ? previous.proporcionMezcla : "",
                    }))
                  }
                />
                Filtrar con mezcla
              </label>
            </div>
          </>
        )}

        {!specialEventActive && form.mezcla && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              marginBottom: 16,
            }}
          >
            <div>
              <label style={{ fontSize: 12, color: textSoft }}>Viene de</label>
              <select
                value={form.origenMezclaTipo}
                onChange={(event) =>
                  setForm((previous) => ({
                    ...previous,
                    origenMezclaTipo: event.target.value as CycleDraft["origenMezclaTipo"],
                    origenMezcla: "",
                  }))
                }
                style={inputStyle}
              >
                <option value="">Seleccionar...</option>
                <option value="bbt">BBT (refiltrar)</option>
                <option value="cct">CCT</option>
              </select>
            </div>

            <div>
              <label style={{ fontSize: 12, color: textSoft }}>
                {form.origenMezclaTipo === "bbt" ? "BBT origen" : "CCT origen"}
              </label>
              <select
                value={form.origenMezcla}
                onChange={(event) => setField("origenMezcla", event.target.value)}
                style={inputStyle}
                disabled={!form.origenMezclaTipo}
              >
                <option value="">Seleccionar...</option>
                {origenOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ fontSize: 12, color: textSoft }}>Proporcion</label>
              <input
                value={form.proporcionMezcla}
                onChange={(event) => setField("proporcionMezcla", event.target.value)}
                placeholder="Ej: 70/30"
                style={inputStyle}
              />
            </div>
          </div>
        )}

        {specialEventActive && (
          <div
            style={{
              ...cardStyle(),
              padding: 14,
              marginBottom: 16,
              background: "#f8fbff",
            }}
          >
            <div style={{ fontSize: 12, color: textSoft, marginBottom: 10 }}>
              {form.aseo
                ? "Para ASEO se anulan automaticamente CCTs, llenados BBT / linea, cantidad y mezcla."
                : "Para mantenimiento se anulan automaticamente CCTs, llenados BBT / linea, cantidad y mezcla."}
            </div>
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: textSoft }}>Color</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            {colorOptions.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setField("color", color)}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  border: form.color === color ? "3px solid #111827" : "1px solid #cbd5e1",
                  background: color,
                  cursor: "pointer",
                }}
              />
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 12, color: textSoft }}>
            {specialEventActive ? "Actividad a realizar" : "Notas"}
          </label>
          <textarea
            value={form.notas}
            onChange={(event) => setField("notas", event.target.value)}
            placeholder={specialEventActive ? "Describe la actividad o evento que se realizara..." : ""}
            style={{ ...inputStyle, minHeight: 90, resize: "vertical" }}
          />
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
          <div>
            {existing && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button onClick={() => onDuplicate(existing.id)} style={buttonStyle()}>
                  Duplicar
                </button>
                <button
                  onClick={() => onDelete(existing.id)}
                  style={{
                    ...buttonStyle(),
                    color: danger,
                    border: `1px solid ${danger}`,
                  }}
                >
                  Eliminar
                </button>
              </div>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "stretch" }}>
            {saveError ? (
              <div
                role="alert"
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  background: "#fee2e2",
                  color: danger,
                  fontSize: 13,
                  fontWeight: 600,
                  lineHeight: 1.45,
                }}
              >
                {saveError}
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button onClick={onClose} style={buttonStyle()}>
                Cancelar
              </button>
              <button onClick={save} style={buttonStyle(true)}>
                Guardar
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConfigListSection({
  title,
  items,
  placeholder,
  addLabel,
  onAdd,
  onRemove,
  usageMap,
}: {
  title: string;
  items: string[];
  placeholder: string;
  addLabel: string;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  usageMap?: Record<string, number>;
}) {
  const [value, setValue] = useState("");

  const addItem = () => {
    const nextValue = value.trim();
    if (!nextValue) return;
    onAdd(nextValue);
    setValue("");
  };

  return (
    <div style={{ ...cardStyle(), padding: 18 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholder}
          style={{ ...inputStyle, marginBottom: 0 }}
        />
        <button onClick={addItem} style={buttonStyle(true)}>
          {addLabel}
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {items.map((item) => {
          const usageCount = usageMap?.[item] || 0;

          return (
            <span
              key={item}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                border: `1px solid ${border}`,
                borderRadius: 999,
                background: "#f8fbff",
                fontSize: 13,
              }}
            >
              {item}
              {usageCount > 0 && (
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: "#e8f1ff",
                    color: primary,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  En uso: {usageCount}
                </span>
              )}
              <button
                onClick={() => onRemove(item)}
                style={{ border: "none", background: "transparent", color: danger, cursor: "pointer" }}
                title={usageCount > 0 ? "Este valor esta en uso en el Gantt." : "Eliminar"}
              >
                x
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function AdminPanel({
  config,
  setConfig,
  usageMaps,
}: {
  config: ConfigState;
  setConfig: React.Dispatch<React.SetStateAction<ConfigState>>;
  usageMaps: UsageMaps;
}) {
  const [newColor, setNewColor] = useState("#3b82f6");
  const [adminNotice, setAdminNotice] = useState<null | { message: string; tone: "error" }>(null);

  useEffect(() => {
    if (!adminNotice) return;

    const timeout = window.setTimeout(() => setAdminNotice(null), 7000);
    return () => window.clearTimeout(timeout);
  }, [adminNotice]);

  const guardRemoval = (label: string, value: string, usageCount: number, remove: () => void) => {
    if (usageCount > 0) {
      setAdminNotice({
        message: `No puedes eliminar ${label} "${value}" porque esta en uso en ${usageCount} ciclo(s).`,
        tone: "error",
      });
      return;
    }

    remove();
  };

  return (
    <div style={{ display: "grid", gap: 18 }}>
      {adminNotice && (
        <div
          role="alert"
          style={{
            ...cardStyle(),
            padding: "12px 16px",
            background: adminNotice.tone === "error" ? "#fee2e2" : primarySoft,
            color: adminNotice.tone === "error" ? danger : text,
            fontWeight: 600,
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          {adminNotice.message}
        </div>
      )}
      <ConfigListSection
        title="Productos"
        items={config.productos}
        placeholder="Nuevo producto"
        addLabel="Agregar"
        onAdd={(value) =>
          setConfig((previous) => ({
            ...previous,
            productos: normalizeStringList([...previous.productos, value]),
          }))
        }
        onRemove={(value) => {
          if (config.productos.length <= 1) {
            setAdminNotice({ message: "Debe quedar al menos un producto configurado.", tone: "error" });
            return;
          }

          guardRemoval("el producto", value, usageMaps.productos[value] || 0, () =>
            setConfig((previous) => ({
              ...previous,
              productos: previous.productos.filter((item) => item !== value),
            }))
          );
        }}
        usageMap={usageMaps.productos}
      />

      <div style={{ ...cardStyle(), padding: 18 }}>
        <h3 style={{ marginTop: 0 }}>Colores</h3>
        <div style={{ display: "flex", gap: 10, marginBottom: 12, alignItems: "center" }}>
          <input
            type="color"
            value={newColor}
            onChange={(event) => setNewColor(event.target.value)}
            style={{ width: 54, height: 40 }}
          />
          <button
            onClick={() =>
              setConfig((previous) => ({
                ...previous,
                colores: previous.colores.includes(newColor) ? previous.colores : [...previous.colores, newColor],
              }))
            }
            style={buttonStyle(true)}
          >
            Agregar color
          </button>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {config.colores.map((color) => (
            <span
              key={color}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                border: `1px solid ${border}`,
                borderRadius: 999,
                background: "#f8fbff",
                fontSize: 13,
              }}
            >
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: color,
                  display: "inline-block",
                }}
              />
              {color}
              {(usageMaps.colores[color] || 0) > 0 && (
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: "#e8f1ff",
                    color: primary,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  En uso: {usageMaps.colores[color]}
                </span>
              )}
              <button
                onClick={() => {
                  if (config.colores.length <= 1) {
                    setAdminNotice({ message: "Debe quedar al menos un color configurado.", tone: "error" });
                    return;
                  }

                  guardRemoval("el color", color, usageMaps.colores[color] || 0, () =>
                    setConfig((previous) => ({
                      ...previous,
                      colores: previous.colores.filter((item) => item !== color),
                    }))
                  );
                }}
                style={{ border: "none", background: "transparent", color: danger, cursor: "pointer" }}
                title={(usageMaps.colores[color] || 0) > 0 ? "Este color esta en uso en el Gantt." : "Eliminar"}
              >
                x
              </button>
            </span>
          ))}
        </div>
      </div>

      <ConfigListSection
        title="CCTs"
        items={config.ccts}
        placeholder="Nuevo CCT"
        addLabel="Agregar CCT"
        onAdd={(value) =>
          setConfig((previous) => ({
            ...previous,
            ccts: normalizeStringList([...previous.ccts, value]),
          }))
        }
        onRemove={(value) =>
          guardRemoval("el CCT", value, usageMaps.ccts[value] || 0, () =>
            setConfig((previous) => ({
              ...previous,
              ccts: previous.ccts.filter((item) => item !== value),
            }))
          )
        }
        usageMap={usageMaps.ccts}
      />

      <ConfigListSection
        title="BBTs"
        items={config.bbts}
        placeholder="Nuevo BBT"
        addLabel="Agregar BBT"
        onAdd={(value) =>
          setConfig((previous) => ({
            ...previous,
            bbts: normalizeStringList([...previous.bbts, value]),
          }))
        }
        onRemove={(value) =>
          guardRemoval("el BBT", value, usageMaps.bbts[value] || 0, () =>
            setConfig((previous) => ({
              ...previous,
              bbts: previous.bbts.filter((item) => item !== value),
            }))
          )
        }
        usageMap={usageMaps.bbts}
      />

      <ConfigListSection
        title="Lineas de envasado"
        items={config.lineasEnvasado}
        placeholder="Nueva linea"
        addLabel="Agregar linea"
        onAdd={(value) =>
          setConfig((previous) => ({
            ...previous,
            lineasEnvasado: normalizeStringList([...previous.lineasEnvasado, value]),
          }))
        }
        onRemove={(value) =>
          guardRemoval("la linea", value, usageMaps.lineasEnvasado[value] || 0, () =>
            setConfig((previous) => ({
              ...previous,
              lineasEnvasado: previous.lineasEnvasado.filter((item) => item !== value),
            }))
          )
        }
        usageMap={usageMaps.lineasEnvasado}
      />
    </div>
  );
}

function AnalysisPanel({
  cycles,
  activeWeekStart,
}: {
  cycles: Cycle[];
  activeWeekStart: string;
}) {
  const [fechaDesde, setFechaDesde] = useState(activeWeekStart);
  const [fechaHasta, setFechaHasta] = useState(addDays(activeWeekStart, 6));
  const [producto, setProducto] = useState("");
  const [linea, setLinea] = useState("");
  const [cct, setCct] = useState("");
  const [bbt, setBbt] = useState("");
  const [onlyMezcla, setOnlyMezcla] = useState(false);
  const [onlyAseo, setOnlyAseo] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(false);

  useEffect(() => {
    setFechaDesde(activeWeekStart);
    setFechaHasta(addDays(activeWeekStart, 6));
  }, [activeWeekStart]);

  const [rangeStartDate, rangeEndDate] = fechaDesde <= fechaHasta ? [fechaDesde, fechaHasta] : [fechaHasta, fechaDesde];
  const rangeStartSlot = slotFromDateHour(rangeStartDate, 0);
  const rangeEndSlot = slotFromDateHour(addDays(rangeEndDate, 1), 0);

  const sourceCycles = useMemo(
    () =>
      cycles.filter((cycle) => {
        const { startSlot, endSlot } = getCycleBounds(cycle);
        return startSlot < rangeEndSlot && endSlot > rangeStartSlot;
      }),
    [cycles, rangeEndSlot, rangeStartSlot]
  );

  const productOptions = useMemo(
    () =>
      Array.from(
        new Set(
          cycles
            .filter((cycle) => !isSpecialEventCycle(cycle) && cycle.producto)
            .map((cycle) => cycle.producto)
        )
      ).sort(),
    [cycles]
  );

  const lineOptions = useMemo(
    () =>
      Array.from(
        new Set(
          cycles
            .flatMap((cycle) => cycle.llenados.flatMap((fill) => fill.lineas))
            .filter(Boolean)
        )
      ).sort(),
    [cycles]
  );

  const cctOptions = useMemo(
    () =>
      Array.from(
        new Set(
          cycles
            .flatMap((cycle) => [
              ...cycle.llenados.map((fill) => fill.cct),
              cycle.origenMezclaTipo === "cct" ? cycle.origenMezcla : "",
            ])
            .filter(Boolean)
        )
      ).sort(),
    [cycles]
  );

  const bbtOptions = useMemo(
    () =>
      Array.from(
        new Set(
          cycles
            .flatMap((cycle) => [
              ...cycle.llenados.map((fill) => fill.bbt),
              cycle.origenMezclaTipo === "bbt" ? cycle.origenMezcla : "",
            ])
            .filter(Boolean)
        )
      ).sort(),
    [cycles]
  );

  const filteredCycles = useMemo(
    () =>
      sourceCycles.filter((cycle) => {
        const cycleIssues = getCycleIssues(cycle);
        const matchesProducto = !producto || cycle.producto === producto;
        const matchesLinea =
          !linea || cycle.llenados.some((fill) => fill.lineas.includes(linea));
        const matchesCct =
          !cct ||
          cycle.llenados.some((fill) => fill.cct === cct) ||
          (cycle.origenMezclaTipo === "cct" && cycle.origenMezcla === cct);
        const matchesBbt =
          !bbt ||
          cycle.llenados.some((fill) => fill.bbt === bbt) ||
          (cycle.origenMezclaTipo === "bbt" && cycle.origenMezcla === bbt);
        const matchesMezcla = !onlyMezcla || cycle.mezcla;
        const matchesAseo = !onlyAseo || cycle.aseo;
        const matchesIssues = !onlyIssues || cycleIssues.length > 0;

        return (
          matchesProducto &&
          matchesLinea &&
          matchesCct &&
          matchesBbt &&
          matchesMezcla &&
          matchesAseo &&
          matchesIssues
        );
      }),
    [sourceCycles, producto, linea, cct, bbt, onlyMezcla, onlyAseo, onlyIssues]
  );

  const rowsWithIssues = useMemo(
    () =>
      filteredCycles.map((cycle) => ({
        cycle,
        issues: getCycleIssues(cycle),
      })),
    [filteredCycles]
  );

  const issueRows = rowsWithIssues.filter((row) => row.issues.length > 0);
  const totalHoras = filteredCycles.reduce((accumulator, cycle) => accumulator + getCycleDurationHours(cycle), 0);
  const totalHl = filteredCycles.reduce((accumulator, cycle) => accumulator + parseQuantity(cycle.cantidadHl), 0);

  const clearFilters = () => {
    setFechaDesde(activeWeekStart);
    setFechaHasta(addDays(activeWeekStart, 6));
    setProducto("");
    setLinea("");
    setCct("");
    setBbt("");
    setOnlyMezcla(false);
    setOnlyAseo(false);
    setOnlyIssues(false);
  };

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div style={{ ...cardStyle(), padding: 18 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <div>
            <h3 style={{ margin: 0 }}>Analisis y validaciones</h3>
            <div style={{ fontSize: 12, color: textSoft, marginTop: 4 }}>
              Filtra ciclos por rango real para revisar datos y detectar faltantes.
            </div>
          </div>
          <button onClick={clearFilters} style={buttonStyle()}>
            Limpiar filtros
          </button>
        </div>

        <div
          style={{
            marginTop: 14,
            padding: "10px 12px",
            borderRadius: 10,
            background: primarySoft,
            color: text,
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          Rango actual: {formatDateLabel(rangeStartDate)} {"->"} {formatDateLabel(rangeEndDate)}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
            marginTop: 16,
          }}
        >
          <div>
            <label style={{ fontSize: 12, color: textSoft }}>Fecha desde</label>
            <input
              type="date"
              value={fechaDesde}
              onChange={(event) => setFechaDesde(event.target.value)}
              style={inputStyle}
            />
          </div>

          <div>
            <label style={{ fontSize: 12, color: textSoft }}>Fecha hasta</label>
            <input
              type="date"
              value={fechaHasta}
              onChange={(event) => setFechaHasta(event.target.value)}
              style={inputStyle}
            />
          </div>

          <div>
            <label style={{ fontSize: 12, color: textSoft }}>Producto</label>
            <select value={producto} onChange={(event) => setProducto(event.target.value)} style={inputStyle}>
              <option value="">Todos</option>
              {productOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ fontSize: 12, color: textSoft }}>Linea</label>
            <select value={linea} onChange={(event) => setLinea(event.target.value)} style={inputStyle}>
              <option value="">Todas</option>
              {lineOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ fontSize: 12, color: textSoft }}>CCT</label>
            <select value={cct} onChange={(event) => setCct(event.target.value)} style={inputStyle}>
              <option value="">Todos</option>
              {cctOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ fontSize: 12, color: textSoft }}>BBT</label>
            <select value={bbt} onChange={(event) => setBbt(event.target.value)} style={inputStyle}>
              <option value="">Todos</option>
              {bbtOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 14 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={onlyMezcla} onChange={(event) => setOnlyMezcla(event.target.checked)} />
            Solo mezclas
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={onlyAseo} onChange={(event) => setOnlyAseo(event.target.checked)} />
            Solo aseos
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={onlyIssues} onChange={(event) => setOnlyIssues(event.target.checked)} />
            Solo con validaciones
          </label>
        </div>
      </div>

      <div
        style={{
          ...cardStyle(),
          padding: 16,
          display: "flex",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        {[
          { label: "CICLOS FILTRADOS", value: filteredCycles.length },
          { label: "HORAS", value: `${totalHoras}h` },
          { label: "HL", value: `${formatQuantity(totalHl)} hl` },
          { label: "CON ALERTAS", value: issueRows.length },
        ].map((item) => (
          <div
            key={item.label}
            style={{
              minWidth: 140,
              padding: "10px 14px",
              borderRadius: 12,
              background: "#f8fbff",
              border: `1px solid ${border}`,
            }}
          >
            <div style={{ fontSize: 20, fontWeight: 700 }}>{item.value}</div>
            <div style={{ fontSize: 11, color: textSoft }}>{item.label}</div>
          </div>
        ))}
      </div>

      <div style={{ ...cardStyle(), padding: 18 }}>
        <h3 style={{ marginTop: 0 }}>Validaciones</h3>
        {issueRows.length === 0 ? (
          <div style={{ color: textSoft, fontSize: 13 }}>
            No se encontraron alertas con los filtros actuales.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {issueRows.map(({ cycle, issues }) => (
              <div
                key={cycle.id}
                style={{
                  border: `1px solid ${border}`,
                  borderRadius: 12,
                  padding: 12,
                  background: "#fffaf5",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 4 }}>{getCycleDisplayName(cycle)}</div>
                <div style={{ fontSize: 12, color: textSoft, marginBottom: 8 }}>
                  {formatDateTimeLabel(cycle.startDate, cycle.startHour)} {"->"} {formatDateTimeLabel(cycle.endDate, cycle.endHour)}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {issues.map((issue) => (
                    <span
                      key={issue}
                      style={{
                        padding: "4px 8px",
                        borderRadius: 999,
                        background: "#fee2e2",
                        color: "#991b1b",
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      {issue}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ ...cardStyle(), padding: 18 }}>
        <h3 style={{ marginTop: 0 }}>Resultados filtrados</h3>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1040 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: `1px solid ${border}` }}>
                {["Inicio", "Fin", "Duracion", "Producto", "CCT", "Llenados", "HL", "Mantenimiento", "Mezcla"].map(
                  (header) => (
                    <th key={header} style={{ padding: "10px 8px", fontSize: 12, color: textSoft }}>
                      {header}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {rowsWithIssues.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ padding: "14px 8px", color: textSoft }}>
                    No hay ciclos para mostrar con los filtros actuales.
                  </td>
                </tr>
              ) : (
                rowsWithIssues.map(({ cycle, issues }) => (
                  <tr key={cycle.id} style={{ borderBottom: `1px solid #eef3f8` }}>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>
                      {formatDateTimeLabel(cycle.startDate, cycle.startHour)}
                    </td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>
                      {formatDateTimeLabel(cycle.endDate, cycle.endHour)}
                    </td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>{getCycleDurationHours(cycle)}h</td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>{getCycleDisplayName(cycle)}</td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>{cycle.ccts || "-"}</td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>
                      {formatCycleFillDetails(cycle.llenados) || "-"}
                    </td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>{cycle.cantidadHl || "-"}</td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>
                      {[
                        cycle.mantenimientoProgramado ? "Programado" : "",
                        cycle.mantenimientoCorrectivo ? "Correctivo" : "",
                      ]
                        .filter(Boolean)
                        .join(" | ") || "-"}
                    </td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>
                      {cycle.mezcla
                        ? `${formatOrigenMezcla(cycle) || "Mezcla"}${
                            cycle.proporcionMezcla ? ` | ${cycle.proporcionMezcla}` : ""
                          }`
                        : "-"}
                      {issues.length > 0 && (
                        <div style={{ color: danger, fontSize: 11, marginTop: 4 }}>
                          {issues.length} alerta(s)
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function InstructionsPanel() {
  return (
    <div style={{ ...cardStyle(), padding: 18 }}>
      <h3 style={{ marginTop: 0 }}>Instrucciones</h3>
      <ul style={{ color: text, lineHeight: 1.7 }}>
        <li>Haz click en una fila vacia del Gantt para crear un ciclo continuo.</li>
        <li>Tap o click sobre un bloque abre el mismo ciclo completo, aunque cruce varios dias.</li>
        <li>Usa el handle del bloque para moverlo sin interferir con el scroll.</li>
        <li>Usa los bordes del bloque para cambiar inicio o fin.</li>
        <li>Si un ciclo choca con otros, la app los reacomoda automaticamente hacia adelante.</li>
        <li>Los ciclos pueden cruzar medianoche y continuar en la siguiente semana.</li>
        <li>Dentro del modal puedes ordenar varios BBTs, asignar CCT origen, cantidad, lineas y rango horario por llenado.</li>
        <li>Si un llenado BBT termina despues del fin del ciclo, el ciclo se extiende automaticamente.</li>
        <li>Desde Admin puedes manejar productos, colores, CCTs, BBTs y lineas sin tocar codigo.</li>
        <li>Puedes exportar la semana visible a Excel o PDF.</li>
      </ul>
    </div>
  );
}

export default function App() {
  const persistedPlan = typeof window !== "undefined" ? readPlanFromBrowserStorage() : null;

  const [cycles, setCycles] = useState<Cycle[]>(() => persistedPlan?.cycles ?? []);
  const [config, setConfig] = useState<ConfigState>(() => persistedPlan?.config ?? DEFAULT_CONFIG);
  const [activeWeekStart, setActiveWeekStart] = useState(() => persistedPlan?.activeWeekStart ?? getStartOfWeek(new Date()));
  const [planView, setPlanView] = useState<PlanViewKey>("week");
  const [selectedDayIndex, setSelectedDayIndex] = useState(getDayIndexFromDate(toDateInputValue(new Date())));
  const [zoom, setZoom] = useState(1);
  const [modal, setModal] = useState<ModalState>(null);
  const [tab, setTab] = useState<TabKey>("plan");
  const [interaction, setInteraction] = useState<InteractionState | null>(null);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [weekPickerOpen, setWeekPickerOpen] = useState(false);
  const [navigatorDate, setNavigatorDate] = useState(
    () => persistedPlan?.activeWeekStart ?? toDateInputValue(new Date())
  );
  const [navigatorHour, setNavigatorHour] = useState(new Date().getHours());
  const [pendingJump, setPendingJump] = useState<JumpTarget | null>(null);
  const [focusedDay, setFocusedDay] = useState<number | null>(null);

  const nextId = useRef(1);
  const dayScrollRefs = useRef<(HTMLDivElement | null)[]>([]);
  const weekPickerRef = useRef<HTMLDivElement | null>(null);
  const lastInteractionMovedIdsRef = useRef<number[]>([]);
  const suppressOpenUntilRef = useRef(0);

  const baseHourWidth = HOUR_WIDTH_BASE * zoom;
  const hourWidth =
    planView === "week"
      ? clamp(Number((baseHourWidth * 0.65).toFixed(2)), 12, 36)
      : baseHourWidth;
  const dayPanelWidth = 24 * hourWidth;
  const usageMaps = useMemo(() => buildUsageMaps(cycles), [cycles]);
  const cycleMap = useMemo(() => new Map(cycles.map((cycle) => [cycle.id, cycle] as const)), [cycles]);
  const visibleWeekCycles = useMemo(() => getVisibleWeekCycles(cycles, activeWeekStart), [cycles, activeWeekStart]);
  const weekSegments = useMemo(() => getVisibleWeekSegments(cycles, activeWeekStart), [cycles, activeWeekStart]);

  useEffect(() => {
    const maxId = cycles.length > 0 ? Math.max(...cycles.map((cycle) => cycle.id)) : 0;
    nextId.current = maxId + 1;
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        localStorage.setItem(
          PLAN_LOCAL_STORAGE_KEY,
          JSON.stringify({
            cycles,
            config,
            activeWeekStart,
          })
        );
      } catch {
        // Quota llena o modo privado: no bloquea la edicion.
      }
    }, 500);

    return () => window.clearTimeout(timeout);
  }, [cycles, config, activeWeekStart]);

  useEffect(() => {
    if (!notice) return;

    const timeout = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!weekPickerOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (weekPickerRef.current?.contains(event.target as Node)) return;
      setWeekPickerOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [weekPickerOpen]);

  useEffect(() => {
    if (!pendingJump || pendingJump.weekStart !== activeWeekStart) return;

    const left = Math.max(0, pendingJump.hour * hourWidth - hourWidth * 1.5);
    dayScrollRefs.current.forEach((node) => {
      node?.scrollTo({ left, behavior: "smooth" });
    });

    setFocusedDay(pendingJump.day);
    setPendingJump(null);
  }, [pendingJump, activeWeekStart, hourWidth]);

  useEffect(() => {
    if (focusedDay === null) return;

    const timeout = window.setTimeout(() => setFocusedDay(null), 2500);
    return () => window.clearTimeout(timeout);
  }, [focusedDay]);

  useEffect(() => {
    if (!interaction) return;

    const move = (event: PointerEvent) => {
      if (event.pointerId !== interaction.pointerId) return;

      const delta = Math.round((event.clientX - interaction.startX) / hourWidth);

      setCycles((previous) => {
        const current = previous.find((cycle) => cycle.id === interaction.cycleId);
        if (!current) return previous;

        let target = current;

        if (interaction.mode === "drag") {
          const nextStart = Math.max(0, interaction.originalStartSlot + delta);
          target = shiftCycle(current, nextStart);
        } else if (interaction.mode === "resize-start") {
          const nextStart = Math.max(
            0,
            Math.min(interaction.originalStartSlot + delta, interaction.originalEndSlot - 1)
          );
          target = resizeCycleStartWithShifts(current, nextStart);
        } else {
          const nextEnd = Math.max(interaction.originalStartSlot + 1, interaction.originalEndSlot + delta);
          target = resizeCycleEndWithFills(current, nextEnd);
        }

        const result = arrangeCyclesWithPriority(
          [...previous.filter((cycle) => cycle.id !== target.id), target],
          target
        );
        lastInteractionMovedIdsRef.current = result.movedIds;
        return result.cycles;
      });
    };

    const up = (event: PointerEvent) => {
      if (event.pointerId !== interaction.pointerId) return;

      if (lastInteractionMovedIdsRef.current.length > 0) {
        setNotice({
          message: `Se reacomodaron ${lastInteractionMovedIdsRef.current.length} ciclo(s).`,
          tone: "info",
        });
      }

      lastInteractionMovedIdsRef.current = [];
      setInteraction(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);

    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [interaction, hourWidth]);

  const pushReflowNotice = (movedCount: number) => {
    if (movedCount <= 0) return;

    setNotice({
      message: `Se reacomodaron ${movedCount} ciclo(s).`,
      tone: "info",
    });
  };

  const createCycle = (date: string, hour: number) => {
    const defaults = rangeFromSlots(slotFromDateHour(date, hour), slotFromDateHour(date, hour) + 2);
    setModal({
      mode: "create",
      defaultStartDate: defaults.startDate,
      defaultStartHour: defaults.startHour,
      defaultEndDate: defaults.endDate,
      defaultEndHour: defaults.endHour,
    });
  };

  const saveCycle = (data: CycleDraft, cycleId?: number) => {
    const id = typeof cycleId === "number" ? cycleId : nextId.current;
    const target: Cycle = {
      id,
      ...data,
    };
    const result = arrangeCyclesWithPriority(
      [...cycles.filter((cycle) => cycle.id !== id), target],
      target
    );

    if (typeof cycleId !== "number") {
      nextId.current += 1;
    }

    setCycles(result.cycles);
    pushReflowNotice(result.movedIds.length);
    setModal(null);
  };

  const deleteCycle = (cycleId: number) => {
    setCycles((previous) => previous.filter((cycle) => cycle.id !== cycleId));
    setModal(null);
  };

  const duplicateCycle = (cycleId: number) => {
    const original = cycles.find((cycle) => cycle.id === cycleId);
    if (!original) return;

    const duration = getCycleDurationHours(original);
    const { endSlot } = getCycleBounds(original);
    const nextStart = findNextAvailableStart(cycles, duration, endSlot);
    const newId = nextId.current;
    const duplicated = shiftCycle({
      ...original,
      id: newId,
      llenados: original.llenados.map((fill) => createCycleFillTarget(fill)),
    }, nextStart);

    nextId.current += 1;
    setCycles((previous) => sortCycles([...previous, duplicated]));
    setNotice({
      message: "Copia creada y ubicada en el siguiente espacio disponible.",
      tone: "success",
    });
    setModal({ mode: "edit", cycleId: newId });
  };

  const startInteraction = (
    event: React.PointerEvent<HTMLElement>,
    cycle: Cycle,
    mode: InteractionMode
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const { startSlot, endSlot } = getCycleBounds(cycle);
    suppressOpenUntilRef.current = Date.now() + 250;
    lastInteractionMovedIdsRef.current = [];
    setInteraction({
      mode,
      pointerId: event.pointerId,
      cycleId: cycle.id,
      startX: event.clientX,
      originalStartSlot: startSlot,
      originalEndSlot: endSlot,
    });

    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const openCycle = (cycleId: number) => {
    if (Date.now() < suppressOpenUntilRef.current) return;
    setModal({ mode: "edit", cycleId });
  };

  const goToCurrentWeek = () => {
    const today = toDateInputValue(new Date());
    setActiveWeekStart(getStartOfWeek(new Date()));
    setNavigatorDate(today);
    setSelectedDayIndex(getDayIndexFromDate(today));
    setFocusedDay(null);
  };

  const goToPreviousWeek = () => {
    const previousWeek = addDays(activeWeekStart, -7);
    setActiveWeekStart(previousWeek);
    setNavigatorDate(previousWeek);
    setFocusedDay(null);
  };

  const goToNextWeek = () => {
    const nextWeek = addDays(activeWeekStart, 7);
    setActiveWeekStart(nextWeek);
    setNavigatorDate(nextWeek);
    setFocusedDay(null);
  };

  const goToDateAndHour = () => {
    const weekStart = getStartOfWeek(navigatorDate);
    const day = getDayIndexFromDate(navigatorDate);

    setActiveWeekStart(weekStart);
    setSelectedDayIndex(day);
    setPendingJump({
      weekStart,
      day,
      hour: navigatorHour,
    });
    setWeekPickerOpen(false);
  };

  const exportExcel = () => {
    const rows = visibleWeekCycles.map((cycle) => ({
      "Inicio fecha": formatDateLabel(cycle.startDate),
      "Inicio hora": formatHour(cycle.startHour),
      "Fin fecha": formatDateLabel(cycle.endDate),
      "Fin hora": formatHour(cycle.endHour),
      "Duracion (h)": getCycleDurationHours(cycle),
      Producto: getCycleDisplayName(cycle),
      CCTs: cycle.ccts,
      BBTs: cycle.bbts,
      "Detalle CCT / BBT / cantidad / horario": formatCycleFillDetails(cycle.llenados),
      "Cantidad (hl)": cycle.cantidadHl,
      "Lineas de envasado": cycle.lineaEnvasado,
      "Mant. programado": cycle.mantenimientoProgramado ? "Si" : "No",
      "Mant. correctivo": cycle.mantenimientoCorrectivo ? "Si" : "No",
      Mezcla: cycle.mezcla ? "Si" : "No",
      "Origen mezcla": formatOrigenMezcla(cycle),
      Proporcion: cycle.proporcionMezcla,
      Aseo: cycle.aseo ? "Si" : "No",
      Notas: cycle.notas,
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Plan");
    XLSX.writeFile(workbook, `plan_filtracion_${activeWeekStart}.xlsx`);
  };

  const exportPDF = () => {
    const document = new jsPDF({ orientation: "landscape" });
    document.setFontSize(16);
    document.text("PLAN DE PRODUCCION DE FILTRACION CERVECERIA DEL ATLANTICO", 14, 16);
    document.setFontSize(11);
    document.text(`Semana visible: ${formatWeekLabel(activeWeekStart)}`, 14, 24);

    autoTable(document, {
      startY: 30,
      head: [[
        "Inicio",
        "Fin",
        "Duracion",
        "Producto",
        "CCTs",
        "Llenados",
        "Cantidad (hl)",
        "Mantenimiento",
        "Mezcla",
      ]],
      body: visibleWeekCycles.map((cycle) => [
        formatDateTimeLabel(cycle.startDate, cycle.startHour),
        formatDateTimeLabel(cycle.endDate, cycle.endHour),
        `${getCycleDurationHours(cycle)}h`,
        getCycleDisplayName(cycle),
        cycle.ccts,
        formatCycleFillDetails(cycle.llenados),
        cycle.cantidadHl,
        [
          cycle.mantenimientoProgramado ? "Programado" : "",
          cycle.mantenimientoCorrectivo ? "Correctivo" : "",
        ]
          .filter(Boolean)
          .join(" | "),
        cycle.mezcla ? `${formatOrigenMezcla(cycle)} ${cycle.proporcionMezcla}`.trim() : "No",
      ]),
      styles: { fontSize: 8 },
    });

    document.save(`plan_filtracion_${activeWeekStart}.pdf`);
  };

  const openDayView = (dayIndex: number) => {
    setSelectedDayIndex(dayIndex);
    setNavigatorDate(addDays(activeWeekStart, dayIndex));
    setPlanView("day");
  };

  const showWeekView = () => {
    setPlanView("week");
  };

  const goToPreviousDayView = () => {
    if (selectedDayIndex === 0) {
      const previousWeek = addDays(activeWeekStart, -7);
      setActiveWeekStart(previousWeek);
      setSelectedDayIndex(6);
      setNavigatorDate(addDays(previousWeek, 6));
      return;
    }

    const nextDayIndex = selectedDayIndex - 1;
    setSelectedDayIndex(nextDayIndex);
    setNavigatorDate(addDays(activeWeekStart, nextDayIndex));
  };

  const goToNextDayView = () => {
    if (selectedDayIndex === 6) {
      const nextWeek = addDays(activeWeekStart, 7);
      setActiveWeekStart(nextWeek);
      setSelectedDayIndex(0);
      setNavigatorDate(nextWeek);
      return;
    }

    const nextDayIndex = selectedDayIndex + 1;
    setSelectedDayIndex(nextDayIndex);
    setNavigatorDate(addDays(activeWeekStart, nextDayIndex));
  };

  const resetLocalPlan = () => {
    if (!window.confirm("Se borrara el plan guardado en este navegador. Continuar?")) return;

    localStorage.removeItem(PLAN_LOCAL_STORAGE_KEY);
    setCycles([]);
    setConfig(DEFAULT_CONFIG);
    const week = getStartOfWeek(new Date());
    setActiveWeekStart(week);
    setNavigatorDate(toDateInputValue(new Date()));
    setSelectedDayIndex(getDayIndexFromDate(toDateInputValue(new Date())));
    setModal(null);
    nextId.current = 1;
  };

  const selectedDayDate = addDays(activeWeekStart, selectedDayIndex);
  const selectedDayStartSlot = slotFromDateHour(selectedDayDate, 0);
  const selectedDayEndSlot = slotFromDateHour(addDays(selectedDayDate, 1), 0);
  const planSummaryCycles =
    planView === "day"
      ? visibleWeekCycles.filter((cycle) => {
          const { startSlot, endSlot } = getCycleBounds(cycle);
          return startSlot < selectedDayEndSlot && endSlot > selectedDayStartSlot;
        })
      : visibleWeekCycles;

  const visibleDayIndexes =
    planView === "day" ? [selectedDayIndex] : DAYS.map((_, dayIndex) => dayIndex);

  const renderDayPanel = (dayIndex: number) => {
    const dayDate = addDays(activeWeekStart, dayIndex);
    const daySegments = weekSegments
      .filter((segment) => segment.dayIndex === dayIndex)
      .sort((left, right) => left.startHour - right.startHour);

    return (
      <div
        key={dayIndex}
        style={{
          ...cardStyle(),
          overflow: "hidden",
          height: "100%",
          width: planView === "week" ? dayPanelWidth : "100%",
          minWidth: planView === "week" ? dayPanelWidth : undefined,
        }}
      >
        <button
          type="button"
          onClick={() => openDayView(dayIndex)}
          style={{
            width: "100%",
            padding: "12px 14px",
            border: "none",
            borderBottom: `1px solid ${border}`,
            background: focusedDay === dayIndex ? primarySoft : "#f8fbff",
            color: focusedDay === dayIndex ? primary : text,
            fontWeight: 700,
            transition: "background 0.2s ease, color 0.2s ease",
            textAlign: "left",
            cursor: planView === "week" ? "pointer" : "default",
          }}
        >
          <div>{DAYS[dayIndex]}</div>
          <div style={{ fontSize: 12, fontWeight: 500, marginTop: 2 }}>{formatDateLabel(dayDate)}</div>
          {planView === "week" && (
            <div style={{ fontSize: 11, marginTop: 4, opacity: 0.75 }}>Abrir dia</div>
          )}
        </button>

        <div
          ref={(node) => {
            dayScrollRefs.current[dayIndex] = node;
          }}
          style={{ overflowX: planView === "week" ? "hidden" : "auto" }}
        >
          <div style={{ minWidth: dayPanelWidth }}>
            <div style={{ display: "flex", borderBottom: `1px solid ${border}` }}>
              {HOURS.map((hour) => (
                <div
                  key={hour}
                  style={{
                    width: hourWidth,
                    minWidth: hourWidth,
                    padding: "6px 4px",
                    borderRight: "1px solid #edf2f7",
                    fontSize: 11,
                    color: textSoft,
                    background: "#fcfdff",
                    boxSizing: "border-box",
                  }}
                >
                  {formatHour(hour)}
                </div>
              ))}
            </div>

            <div
              style={{
                position: "relative",
                display: "flex",
                height: GANTT_ROW_HEIGHT,
                cursor: "crosshair",
              }}
              onClick={(event) => {
                const target = event.target as HTMLElement;
                if (target.closest("[data-cycle-segment='true']")) return;

                const rect = event.currentTarget.getBoundingClientRect();
                const x = event.clientX - rect.left;
                const hour = clamp(Math.floor(x / hourWidth), 0, 23);
                createCycle(dayDate, hour);
              }}
            >
              {HOURS.map((hour) => (
                <div
                  key={hour}
                  style={{
                    width: hourWidth,
                    minWidth: hourWidth,
                    borderRight: "1px solid #edf2f7",
                    boxSizing: "border-box",
                  }}
                />
              ))}

              {daySegments.map((segment) => {
                const cycle = cycleMap.get(segment.cycleId);
                if (!cycle) return null;

                const segmentLabel = `${segment.continuesBefore ? "< " : ""}${getCycleDisplayName(cycle)}${
                  segment.continuesAfter ? " >" : ""
                }`;
                const overlapFills = getFillsOverlappingDaySegment(cycle, dayDate, segment);
                const fallbackSummaryLines =
                  overlapFills.length === 0 && !isSpecialEventCycle(cycle)
                    ? [
                        cycle.ccts.trim() ? `CCT: ${cycle.ccts}` : "",
                        cycle.bbts.trim() ? `BBT: ${cycle.bbts}` : "",
                        cycle.lineaEnvasado.trim() ? `Lineas: ${cycle.lineaEnvasado}` : "",
                        cycle.cantidadHl.trim() ? `Cantidad: ${cycle.cantidadHl} hl` : "",
                      ].filter(Boolean)
                    : [];

                return (
                  <div
                    key={segment.key}
                    data-cycle-segment="true"
                    title={formatCycleTooltip(cycle)}
                    style={{
                      position: "absolute",
                      left: segment.startHour * hourWidth,
                      width: Math.max((segment.endHour - segment.startHour) * hourWidth, 18),
                      top: 6,
                      height: GANTT_ROW_HEIGHT - 12,
                      background: cycle.color,
                      color: "#fff",
                      borderRadius: 10,
                      borderTopLeftRadius: segment.continuesBefore ? 3 : 10,
                      borderBottomLeftRadius: segment.continuesBefore ? 3 : 10,
                      borderTopRightRadius: segment.continuesAfter ? 3 : 10,
                      borderBottomRightRadius: segment.continuesAfter ? 3 : 10,
                      boxShadow: "0 8px 20px rgba(0,0,0,0.12)",
                      overflow: "hidden",
                    }}
                  >
                    <button
                      type="button"
                      onPointerDown={(event) => startInteraction(event, cycle, "resize-start")}
                      onClick={(event) => event.stopPropagation()}
                      aria-label="Redimensionar inicio"
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: 12,
                        border: "none",
                        background: "rgba(15,23,42,0.18)",
                        cursor: "ew-resize",
                        padding: 0,
                      }}
                    />

                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        openCycle(cycle.id);
                      }}
                      style={{
                        position: "absolute",
                        inset: 0,
                        border: "none",
                        background: "transparent",
                        color: "inherit",
                        textAlign: "left",
                        padding: "8px 16px 6px 30px",
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "flex-start",
                        gap: 3,
                      }}
                    >
                      <span
                        style={{
                          fontWeight: 700,
                          fontSize: 12,
                          overflow: "hidden",
                          wordBreak: "break-word",
                          lineHeight: 1.2,
                          flexShrink: 0,
                          maxHeight: 30,
                          display: "block",
                        }}
                      >
                        {segmentLabel}
                      </span>
                      <div
                        style={{
                          flex: 1,
                          minHeight: 0,
                          overflow: "auto",
                          marginTop: 2,
                          fontSize: 9,
                          lineHeight: 1.35,
                          fontWeight: 600,
                          opacity: 0.95,
                          wordBreak: "break-word",
                        }}
                      >
                        {isSpecialEventCycle(cycle) ? (
                          cycle.notas.trim() ? (
                            <div>{cycle.notas}</div>
                          ) : null
                        ) : overlapFills.length > 0 ? (
                          overlapFills.map((fill, fillIdx) => (
                            <div
                              key={fill.id}
                              style={{
                                marginTop: fillIdx === 0 ? 0 : 5,
                                paddingLeft: 6,
                                borderLeft: "3px solid rgba(255,255,255,0.45)",
                              }}
                            >
                              <div style={{ opacity: 0.95 }}>{formatFillTimeRange(fill)}</div>
                              {fill.cct.trim() ? (
                                <div>
                                  <span style={{ opacity: 0.75 }}>CCT </span>
                                  {fill.cct}
                                </div>
                              ) : null}
                              {fill.bbt.trim() ? (
                                <div>
                                  <span style={{ opacity: 0.75 }}>BBT </span>
                                  {fill.bbt}
                                </div>
                              ) : null}
                              {fill.lineas.length > 0 ? (
                                <div>
                                  <span style={{ opacity: 0.75 }}>Lin </span>
                                  {normalizeStringList(fill.lineas).join(", ")}
                                </div>
                              ) : null}
                              {fill.cantidadHl.trim() ? (
                                <div>
                                  <span style={{ opacity: 0.75 }}>Hl </span>
                                  {fill.cantidadHl}
                                </div>
                              ) : null}
                            </div>
                          ))
                        ) : fallbackSummaryLines.length > 0 ? (
                          fallbackSummaryLines.map((line, idx) => (
                            <div key={`${idx}-${line}`} style={{ marginTop: 2 }}>
                              {line}
                            </div>
                          ))
                        ) : (
                          <div style={{ fontWeight: 500, opacity: 0.88 }}>(Sin detalle de llenado)</div>
                        )}
                      </div>
                    </button>

                    <button
                      type="button"
                      onPointerDown={(event) => startInteraction(event, cycle, "drag")}
                      onClick={(event) => event.stopPropagation()}
                      aria-label="Mover ciclo"
                      style={{
                        position: "absolute",
                        left: 12,
                        top: Math.min(52, Math.max(10, Math.floor(GANTT_ROW_HEIGHT * 0.32))),
                        width: 14,
                        height: 26,
                        borderRadius: 7,
                        border: "none",
                        background: "rgba(15,23,42,0.28)",
                        color: "#fff",
                        fontSize: 10,
                        fontWeight: 700,
                        cursor: "grab",
                        padding: 0,
                      }}
                    >
                      ::
                    </button>

                    <button
                      type="button"
                      onPointerDown={(event) => startInteraction(event, cycle, "resize-end")}
                      onClick={(event) => event.stopPropagation()}
                      aria-label="Redimensionar fin"
                      style={{
                        position: "absolute",
                        right: 0,
                        top: 0,
                        bottom: 0,
                        width: 12,
                        border: "none",
                        background: "rgba(15,23,42,0.18)",
                        cursor: "ew-resize",
                        padding: 0,
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: appBg,
        color: text,
        padding: 20,
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div
        style={{
          ...cardStyle(),
          padding: 16,
          marginBottom: 16,
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>
            PLAN DE PRODUCCION DE FILTRACION CERVECERIA DEL ATLANTICO
          </div>
          <div style={{ fontSize: 13, color: textSoft }}>
            Plan semanal dinamico con ciclos continuos — guardado en este equipo (navegador)
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={() => setTab("plan")} style={buttonStyle(tab === "plan")}>
            Plan
          </button>
          <button onClick={() => setTab("analysis")} style={buttonStyle(tab === "analysis")}>
            Analisis
          </button>
          <button onClick={() => setTab("admin")} style={buttonStyle(tab === "admin")}>
            Admin
          </button>
          <button onClick={() => setTab("instructions")} style={buttonStyle(tab === "instructions")}>
            Instrucciones
          </button>
          <button onClick={resetLocalPlan} style={buttonStyle()}>
            Limpiar plan local
          </button>
        </div>
      </div>

      {tab === "plan" && (
        <>
          <div
            style={{
              ...cardStyle(),
              padding: 16,
              marginBottom: 16,
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <button onClick={goToPreviousWeek} style={buttonStyle()}>
              {"<"} Semana anterior
            </button>

            <button onClick={goToCurrentWeek} style={buttonStyle()}>
              Semana actual
            </button>

            <button onClick={goToNextWeek} style={buttonStyle()}>
              Semana siguiente {">"}
            </button>

            <div ref={weekPickerRef} style={{ position: "relative" }}>
              <button
                onClick={() => setWeekPickerOpen((open) => !open)}
                style={{
                  ...buttonStyle(weekPickerOpen),
                  minWidth: 240,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 3,
                }}
              >
                <span style={{ fontSize: 11, opacity: weekPickerOpen ? 0.85 : 0.65 }}>SEMANA VISIBLE</span>
                <span>{formatWeekLabel(activeWeekStart)}</span>
              </button>

              {weekPickerOpen && (
                <div
                  style={{
                    ...cardStyle(),
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    left: 0,
                    width: 320,
                    maxWidth: "calc(100vw - 48px)",
                    padding: 16,
                    zIndex: 30,
                  }}
                >
                  <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Ir a una fecha y hora</div>
                  <div style={{ fontSize: 12, color: textSoft, lineHeight: 1.5 }}>
                    La vista abrira la semana correspondiente y dejara el foco en la hora seleccionada.
                  </div>

                  <div style={{ marginTop: 14 }}>
                    <label style={{ fontSize: 12, color: textSoft }}>Fecha</label>
                    <input
                      type="date"
                      value={navigatorDate}
                      onChange={(event) => setNavigatorDate(event.target.value)}
                      style={inputStyle}
                    />
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <label style={{ fontSize: 12, color: textSoft }}>Hora</label>
                    <select
                      value={navigatorHour}
                      onChange={(event) => setNavigatorHour(Number(event.target.value))}
                      style={inputStyle}
                    >
                      {HOURS.map((hour) => (
                        <option key={hour} value={hour}>
                          {formatHour(hour)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div
                    style={{
                      marginTop: 12,
                      padding: "10px 12px",
                      borderRadius: 10,
                      background: primarySoft,
                      color: text,
                      fontSize: 12,
                      lineHeight: 1.5,
                    }}
                  >
                    Dia seleccionado: {DAYS[getDayIndexFromDate(navigatorDate)]}
                  </div>

                  <button
                    onClick={goToDateAndHour}
                    style={{ ...buttonStyle(true), marginTop: 14, width: "100%" }}
                  >
                    Ir a fecha y hora
                  </button>
                </div>
              )}
            </div>

            <div style={{ marginLeft: "auto", display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={showWeekView} style={buttonStyle(planView === "week")}>
                Semanal
              </button>
              <button onClick={() => setPlanView("day")} style={buttonStyle(planView === "day")}>
                Dia
              </button>
              {planView === "day" && (
                <>
                  <button onClick={goToPreviousDayView} style={buttonStyle()}>
                    {"<"} Dia
                  </button>
                  <div
                    style={{
                      padding: "10px 14px",
                      borderRadius: 10,
                      background: primarySoft,
                      border: `1px solid ${border}`,
                      fontWeight: 700,
                    }}
                  >
                    {DAYS[selectedDayIndex]} | {formatDateLabel(selectedDayDate)}
                  </div>
                  <button onClick={goToNextDayView} style={buttonStyle()}>
                    Dia {">"}
                  </button>
                </>
              )}
              <button
                onClick={() => setZoom((value) => clamp(Number((value - 0.1).toFixed(2)), MIN_ZOOM, MAX_ZOOM))}
                style={buttonStyle()}
              >
                -
              </button>
              <div style={{ minWidth: 70, textAlign: "center", fontWeight: 700, paddingTop: 10 }}>
                {Math.round(zoom * 100)}%
              </div>
              <button
                onClick={() => setZoom((value) => clamp(Number((value + 0.1).toFixed(2)), MIN_ZOOM, MAX_ZOOM))}
                style={buttonStyle()}
              >
                +
              </button>
              <button onClick={exportExcel} style={buttonStyle()}>
                Exportar Excel
              </button>
              <button onClick={exportPDF} style={buttonStyle()}>
                Exportar PDF
              </button>
            </div>
          </div>

          {notice && (
            <div
              style={{
                ...cardStyle(),
                padding: "12px 16px",
                marginBottom: 16,
                background: notice.tone === "success" ? successSoft : primarySoft,
                color: notice.tone === "success" ? successText : primary,
                fontWeight: 700,
              }}
            >
              {notice.message}
            </div>
          )}

          <StatsBar cycles={planSummaryCycles} />

          <div
            style={{
              ...cardStyle(),
              padding: 16,
              marginBottom: 16,
              fontSize: 12,
              color: textSoft,
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <span>Click en una fila vacia para crear ciclo</span>
            <span>|</span>
            <span>Click o tap sobre el bloque para editar</span>
            <span>|</span>
            <span>Handle :: para mover</span>
            <span>|</span>
            <span>Bordes para redimensionar</span>
            <span>|</span>
            <span>El Gantt reacomoda choques automaticamente</span>
            <span>|</span>
            <span>Los ciclos pueden seguir al dia o semana siguiente</span>
          </div>

          {planView === "week" ? (
            <div style={{ overflowX: "auto", paddingBottom: 4 }}>
              <div
                style={{
                  display: "grid",
                  gridAutoFlow: "column",
                  gridAutoColumns: `${dayPanelWidth}px`,
                  gap: 12,
                  alignItems: "start",
                }}
              >
                {visibleDayIndexes.map((dayIndex) => renderDayPanel(dayIndex))}
              </div>
            </div>
          ) : (
            <div>{renderDayPanel(selectedDayIndex)}</div>
          )}
        </>
      )}

      {tab === "analysis" && <AnalysisPanel cycles={cycles} activeWeekStart={activeWeekStart} />}
      {tab === "admin" && <AdminPanel config={config} setConfig={setConfig} usageMaps={usageMaps} />}
      {tab === "instructions" && <InstructionsPanel />}

      <CycleModal
        openState={modal}
        cycles={cycles}
        activeWeekStart={activeWeekStart}
        config={config}
        onClose={() => setModal(null)}
        onSave={saveCycle}
        onDelete={deleteCycle}
        onDuplicate={duplicateCycle}
      />
    </div>
  );
}
