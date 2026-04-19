import React, { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

type Cycle = {
  id: number;
  weekStart: string;
  dia: number;
  horaInicio: number;
  horaFin: number;
  producto: string;
  color: string;
  aseo: boolean;
  ccts: string;
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

type CycleDraft = Omit<Cycle, "id" | "weekStart">;

type ModalState =
  | null
  | {
      mode: "create" | "edit";
      cycleId?: number;
      defaultDia?: number;
      defaultHora?: number;
    };

type DragState = {
  id: number;
  startX: number;
  originalInicio: number;
  duration: number;
};

type ResizeState = {
  id: number;
  edge: "left" | "right";
  startX: number;
  originalInicio: number;
  originalFin: number;
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

type TabKey = "plan" | "analysis" | "admin" | "instructions";
type PlanViewKey = "week" | "day";

const DAYS = ["LUN", "MAR", "MI\u00c9", "JUE", "VIE", "S\u00c1B", "DOM"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

const STORAGE_KEY = "gantt-filtracion-semanal-v2";
const HOUR_WIDTH_BASE = 56;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.2;
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
const danger = "#b91c1c";

function toDateInputValue(date: Date) {
  const local = new Date(date);
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  return local.toISOString().slice(0, 10);
}

function parseDateValue(value: string) {
  return new Date(`${value}T00:00:00`);
}

function getStartOfWeek(date: Date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().split("T")[0];
}

function addDays(base: string, days: number) {
  const d = parseDateValue(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function getDayIndexFromDate(value: string) {
  const day = parseDateValue(value).getDay();
  return day === 0 ? 6 : day - 1;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function formatDateFromDate(date: Date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function formatWeekLabel(weekStart: string) {
  const start = parseDateValue(weekStart);
  const end = parseDateValue(weekStart);
  end.setDate(end.getDate() + 6);

  return `${formatDateFromDate(start)} \u2192 ${formatDateFromDate(end)}`;
}

function formatDayReference(weekStart: string, dayIndex: number) {
  const date = parseDateValue(addDays(weekStart, dayIndex));
  return formatDateFromDate(date);
}

function getCycleDateValue(weekStart: string, dayIndex: number) {
  return addDays(weekStart, dayIndex);
}

function formatDateLabel(dateValue: string) {
  return formatDateFromDate(parseDateValue(dateValue));
}

function formatHour(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
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

function readStringArray(value: unknown, fallback: string[] = []) {
  if (!Array.isArray(value)) return fallback;

  const parsed = value.filter((item): item is string => typeof item === "string");
  const normalized = normalizeStringList(parsed);
  return normalized.length > 0 ? normalized : fallback;
}

function getSelectOptions(options: string[], currentValue: string) {
  return normalizeStringList(currentValue ? [currentValue, ...options] : options);
}

function buildConfigState(config?: Partial<ConfigState>): ConfigState {
  return {
    productos: readStringArray(config?.productos, DEFAULT_CONFIG.productos),
    colores: readStringArray(config?.colores, DEFAULT_CONFIG.colores),
    ccts: normalizeStringList([...DEFAULT_CCTS, ...readStringArray(config?.ccts, DEFAULT_CONFIG.ccts)]),
    bbts: normalizeStringList([...DEFAULT_BBTS, ...readStringArray(config?.bbts, DEFAULT_CONFIG.bbts)]),
    lineasEnvasado: readStringArray(config?.lineasEnvasado, DEFAULT_CONFIG.lineasEnvasado),
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
  defaults?: Partial<Pick<CycleDraft, "dia" | "horaInicio" | "horaFin">>
): CycleDraft {
  return {
    dia: defaults?.dia ?? 0,
    horaInicio: defaults?.horaInicio ?? 6,
    horaFin: defaults?.horaFin ?? 8,
    producto: config.productos[0] || "",
    color: config.colores[0] || "#3b82f6",
    aseo: false,
    ccts: "",
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

function hydrateCycle(raw: Record<string, unknown>): Cycle {
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    weekStart: typeof raw.weekStart === "string" ? raw.weekStart : getStartOfWeek(new Date()),
    dia: typeof raw.dia === "number" ? raw.dia : 0,
    horaInicio: typeof raw.horaInicio === "number" ? raw.horaInicio : 6,
    horaFin: typeof raw.horaFin === "number" ? raw.horaFin : 8,
    producto: typeof raw.producto === "string" ? raw.producto : "",
    color: typeof raw.color === "string" ? raw.color : "#3b82f6",
    aseo: Boolean(raw.aseo),
    ccts: typeof raw.ccts === "string" ? raw.ccts : "",
    bbts: typeof raw.bbts === "string" ? raw.bbts : "",
    cantidadHl: typeof raw.cantidadHl === "string" ? raw.cantidadHl : "",
    lineaEnvasado: typeof raw.lineaEnvasado === "string" ? raw.lineaEnvasado : "",
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

function resolveDayCollisions(dayCycles: Cycle[]): Cycle[] {
  const sorted = [...dayCycles].sort((a, b) => a.horaInicio - b.horaInicio);

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];

    if (curr.horaInicio < prev.horaFin) {
      const duration = curr.horaFin - curr.horaInicio;
      curr.horaInicio = prev.horaFin;
      curr.horaFin = Math.min(24, curr.horaInicio + duration);

      if (curr.horaFin - curr.horaInicio < 1) {
        curr.horaInicio = 23;
        curr.horaFin = 24;
      }
    }
  }

  return sorted;
}

function normalizeWeekCycles(cycles: Cycle[], weekStart: string): Cycle[] {
  const sameWeek = cycles.filter((c) => c.weekStart === weekStart);
  const otherWeeks = cycles.filter((c) => c.weekStart !== weekStart);

  const normalized = DAYS.map((_, dayIndex) =>
    resolveDayCollisions(
      sameWeek
        .filter((c) => c.dia === dayIndex)
        .map((c) => ({ ...c }))
    )
  ).flat();

  return [
    ...otherWeeks,
    ...sameWeek.map((c) => normalized.find((x) => x.id === c.id) || c),
  ];
}

function validateCycle(cycle: CycleDraft) {
  if (cycle.horaInicio < 0 || cycle.horaInicio > 23) return "Hora inicio invalida.";
  if (cycle.horaFin < 1 || cycle.horaFin > 24) return "Hora fin invalida.";
  if (cycle.horaFin <= cycle.horaInicio) return "La hora fin debe ser mayor a la hora inicio.";

  if (!isSpecialEventCycle(cycle) && !cycle.producto.trim()) {
    return "Producto requerido.";
  }

  if (cycle.aseo && !cycle.notas.trim()) {
    return "Describe en notas lo que se realizara en el aseo.";
  }

  if (isMaintenanceEvent(cycle) && !cycle.notas.trim()) {
    return "Describe en notas lo que se realizara en el mantenimiento.";
  }

  if (!isSpecialEventCycle(cycle) && cycle.mezcla) {
    if (!cycle.origenMezclaTipo) return "Selecciona si la mezcla viene de BBT o CCT.";
    if (!cycle.origenMezcla.trim()) return "Selecciona el origen de la mezcla.";
    if (!cycle.proporcionMezcla.trim()) return "La proporcion de mezcla es requerida.";
  }

  return null;
}

function formatCycleTooltip(cycle: Cycle) {
  const lines = [
    getCycleDisplayName(cycle),
    `Horario: ${formatHour(cycle.horaInicio)} - ${formatHour(cycle.horaFin)}`,
  ];

  if (!isSpecialEventCycle(cycle)) {
    if (cycle.ccts) lines.push(`CCTs: ${cycle.ccts}`);
    if (cycle.bbts) lines.push(`BBTs: ${cycle.bbts}`);
    if (cycle.cantidadHl) lines.push(`Cantidad: ${cycle.cantidadHl} hl`);
    if (cycle.lineaEnvasado) lines.push(`Linea de envasado: ${cycle.lineaEnvasado}`);
    if (cycle.mezcla) lines.push("Mezcla: Si");
    if (formatOrigenMezcla(cycle)) lines.push(`Origen mezcla: ${formatOrigenMezcla(cycle)}`);
    if (cycle.proporcionMezcla) lines.push(`Proporcion: ${cycle.proporcionMezcla}`);
  }
  if (cycle.notas) lines.push(`Notas: ${cycle.notas}`);

  return lines.join("\n");
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
    if (!cycle.aseo) {
      incrementUsage(usageMaps.productos, cycle.producto);
    }

    incrementUsage(usageMaps.colores, cycle.color);
    incrementUsage(usageMaps.ccts, cycle.ccts);
    incrementUsage(usageMaps.bbts, cycle.bbts);
    incrementUsage(usageMaps.lineasEnvasado, cycle.lineaEnvasado);

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

  if (cycle.aseo) {
    if (!cycle.notas.trim()) issues.push("Sin detalle del aseo.");
  } else if (isMaintenanceEvent(cycle)) {
    if (!cycle.notas.trim()) issues.push("Sin detalle del mantenimiento.");
  } else {
    if (!cycle.producto.trim()) issues.push("Sin producto.");
    if (!cycle.ccts.trim()) issues.push("Sin CCT asignado.");
    if (!cycle.bbts.trim()) issues.push("Sin BBT asignado.");
    if (!cycle.cantidadHl.trim()) issues.push("Sin cantidad (hl).");
    if (!cycle.lineaEnvasado.trim()) issues.push("Sin linea de envasado.");
  }
  if (cycle.horaFin <= cycle.horaInicio) issues.push("Horario invalido.");

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
  const totalHoras = cycles.reduce((acc, c) => acc + (c.horaFin - c.horaInicio), 0);
  const totalHl = cycles.reduce((acc, c) => acc + parseQuantity(c.cantidadHl), 0);
  const aseos = cycles.filter((c) => c.aseo).length;
  const productos = [
    ...new Set(
      cycles
        .filter((c) => !isSpecialEventCycle(c) && c.producto)
        .map((c) => c.producto)
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
      ? cycles.find((c) => c.id === openState.cycleId) || null
      : null;

  const [form, setForm] = useState<CycleDraft>(() => createEmptyCycle(config));

  useEffect(() => {
    if (!openState) return;

    if (existing) {
      setForm({
        dia: existing.dia,
        horaInicio: existing.horaInicio,
        horaFin: existing.horaFin,
        producto: existing.producto,
        color: existing.color,
        aseo: existing.aseo,
        ccts: existing.ccts,
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
      });
    } else {
      const horaInicio = openState.defaultHora ?? 6;

      setForm(
        createEmptyCycle(config, {
          dia: openState.defaultDia ?? 0,
          horaInicio,
          horaFin: Math.min(horaInicio + 2, 24),
        })
      );
    }
  }, [openState, existing, config]);

  if (!openState) return null;

  const setField = <K extends keyof CycleDraft>(key: K, value: CycleDraft[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const cctsOptions = getSelectOptions(config.ccts, form.ccts);
  const bbtsOptions = getSelectOptions(config.bbts, form.bbts);
  const lineasOptions = getSelectOptions(config.lineasEnvasado, form.lineaEnvasado);
  const origenOptions = getSelectOptions(
    form.origenMezclaTipo === "bbt" ? config.bbts : config.ccts,
    form.origenMezcla
  );
  const specialEventActive = isSpecialEventCycle(form);
  const colorOptions = getSelectOptions(config.colores, form.color);
  const defaultProduct = config.productos[0] || "";
  const defaultColor = config.colores[0] || "#3b82f6";

  const handleAseo = (checked: boolean) => {
    setForm((prev) => ({
      ...prev,
      aseo: checked,
      mantenimientoProgramado: checked ? false : prev.mantenimientoProgramado,
      mantenimientoCorrectivo: checked ? false : prev.mantenimientoCorrectivo,
      producto: checked ? "ASEO" : defaultProduct,
      color: checked ? "#94a3b8" : defaultColor,
      ccts: checked ? "" : prev.ccts,
      bbts: checked ? "" : prev.bbts,
      cantidadHl: checked ? "" : prev.cantidadHl,
      lineaEnvasado: checked ? "" : prev.lineaEnvasado,
      mezcla: checked ? false : prev.mezcla,
      origenMezclaTipo: checked ? "" : prev.origenMezclaTipo,
      origenMezcla: checked ? "" : prev.origenMezcla,
      proporcionMezcla: checked ? "" : prev.proporcionMezcla,
    }));
  };

  const handleMaintenanceChange = (
    type: "preventivo" | "correctivo",
    checked: boolean
  ) => {
    setForm((prev) => {
      const nextProgramado = type === "preventivo" ? checked : checked ? false : prev.mantenimientoProgramado;
      const nextCorrectivo = type === "correctivo" ? checked : checked ? false : prev.mantenimientoCorrectivo;
      const nextMaintenanceActive = nextProgramado || nextCorrectivo;

      return {
        ...prev,
        aseo: nextMaintenanceActive ? false : prev.aseo,
        mantenimientoProgramado: nextProgramado,
        mantenimientoCorrectivo: nextCorrectivo,
        producto: nextMaintenanceActive ? "" : defaultProduct,
        color: nextMaintenanceActive
          ? nextCorrectivo
            ? "#dc2626"
            : "#f59e0b"
          : defaultColor,
        ccts: nextMaintenanceActive ? "" : prev.ccts,
        bbts: nextMaintenanceActive ? "" : prev.bbts,
        cantidadHl: nextMaintenanceActive ? "" : prev.cantidadHl,
        lineaEnvasado: nextMaintenanceActive ? "" : prev.lineaEnvasado,
        mezcla: nextMaintenanceActive ? false : prev.mezcla,
        origenMezclaTipo: nextMaintenanceActive ? "" : prev.origenMezclaTipo,
        origenMezcla: nextMaintenanceActive ? "" : prev.origenMezcla,
        proporcionMezcla: nextMaintenanceActive ? "" : prev.proporcionMezcla,
      };
    });
  };

  const save = () => {
    const err = validateCycle(form);
    if (err) {
      alert(err);
      return;
    }
    onSave(form, existing?.id);
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
          width: 680,
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
          }}
        >
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: text }}>
              {existing ? "Editar ciclo" : "Nuevo ciclo"}
            </div>
            <div style={{ fontSize: 12, color: textSoft }}>
              Semana: {formatWeekLabel(activeWeekStart)}
            </div>
          </div>
          <button onClick={onClose} style={{ ...buttonStyle(), padding: "6px 10px" }}>
            x
          </button>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: textSoft }}>Dia</label>
          <select
            value={form.dia}
            onChange={(e) => setField("dia", Number(e.target.value))}
            style={inputStyle}
          >
            {DAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: textSoft }}>Inicio</label>
            <input
              type="number"
              min={0}
              max={23}
              value={form.horaInicio}
              onChange={(e) => {
                const inicio = clamp(Number(e.target.value), 0, 23);
                setField("horaInicio", inicio);
                if (form.horaFin <= inicio) setField("horaFin", inicio + 1);
              }}
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: textSoft }}>Fin</label>
            <input
              type="number"
              min={1}
              max={24}
              value={form.horaFin}
              onChange={(e) =>
                setField("horaFin", clamp(Number(e.target.value), form.horaInicio + 1, 24))
              }
              style={inputStyle}
            />
          </div>
        </div>

        <div style={{ marginBottom: 16, display: "flex", gap: 18, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={form.aseo}
              onChange={(e) => handleAseo(e.target.checked)}
            />
            ASEO
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={form.mantenimientoProgramado}
              onChange={(e) => handleMaintenanceChange("preventivo", e.target.checked)}
            />
            Mantenimiento preventivo
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={form.mantenimientoCorrectivo}
              onChange={(e) => handleMaintenanceChange("correctivo", e.target.checked)}
            />
            Mantenimiento correctivo
          </label>
        </div>

        {!specialEventActive && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, color: textSoft }}>Producto</label>
            <select
              value={form.producto}
              onChange={(e) => setField("producto", e.target.value)}
              style={inputStyle}
            >
              <option value="">Seleccionar...</option>
              {config.productos.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        )}

        {!specialEventActive && (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 12,
                marginBottom: 16,
              }}
            >
              <div>
                <label style={{ fontSize: 12, color: textSoft }}>CCTs</label>
                <select
                  value={form.ccts}
                  onChange={(e) => setField("ccts", e.target.value)}
                  style={inputStyle}
                >
                  <option value="">Seleccionar...</option>
                  {cctsOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ fontSize: 12, color: textSoft }}>BBTs</label>
                <select
                  value={form.bbts}
                  onChange={(e) => setField("bbts", e.target.value)}
                  style={inputStyle}
                >
                  <option value="">Seleccionar...</option>
                  {bbtsOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ fontSize: 12, color: textSoft }}>Cantidad (hl)</label>
                <input
                  type="number"
                  min={0}
                  step="0.1"
                  value={form.cantidadHl}
                  onChange={(e) => setField("cantidadHl", e.target.value)}
                  placeholder="Ej: 120"
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={{ fontSize: 12, color: textSoft }}>Linea de envasado</label>
                <select
                  value={form.lineaEnvasado}
                  onChange={(e) => setField("lineaEnvasado", e.target.value)}
                  style={inputStyle}
                >
                  <option value="">Seleccionar...</option>
                  {lineasOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={form.mezcla}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      mezcla: e.target.checked,
                      origenMezclaTipo: e.target.checked ? prev.origenMezclaTipo : "",
                      origenMezcla: e.target.checked ? prev.origenMezcla : "",
                      proporcionMezcla: e.target.checked ? prev.proporcionMezcla : "",
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
                onChange={(e) => {
                  const value = e.target.value as CycleDraft["origenMezclaTipo"];
                  setForm((prev) => ({
                    ...prev,
                    origenMezclaTipo: value,
                    origenMezcla: "",
                  }));
                }}
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
                onChange={(e) => setField("origenMezcla", e.target.value)}
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
                onChange={(e) => setField("proporcionMezcla", e.target.value)}
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
                ? "Para ASEO se anulan automaticamente CCTs, BBTs, cantidad, linea de envasado y mezcla."
                : "Para mantenimiento se anulan automaticamente CCTs, BBTs, cantidad, linea de envasado y mezcla."}
            </div>
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: textSoft }}>Color</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            {colorOptions.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setField("color", c)}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  border: form.color === c ? "3px solid #111827" : "1px solid #cbd5e1",
                  background: c,
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
            onChange={(e) => setField("notas", e.target.value)}
            placeholder={
              specialEventActive ? "Describe la actividad o evento que se realizara..." : ""
            }
            style={{ ...inputStyle, minHeight: 90, resize: "vertical" }}
          />
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
          <div>
            {existing && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  onClick={() => onDuplicate(existing.id)}
                  style={buttonStyle()}
                >
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
          <div style={{ display: "flex", gap: 10 }}>
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
          onChange={(e) => setValue(e.target.value)}
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

  const guardRemoval = (
    label: string,
    value: string,
    usageCount: number,
    remove: () => void
  ) => {
    if (usageCount > 0) {
      alert(`No puedes eliminar ${label} "${value}" porque esta en uso en ${usageCount} ciclo(s).`);
      return;
    }

    remove();
  };

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <ConfigListSection
        title="Productos"
        items={config.productos}
        placeholder="Nuevo producto"
        addLabel="Agregar"
        onAdd={(value) =>
          setConfig((prev) => ({
            ...prev,
            productos: normalizeStringList([...prev.productos, value]),
          }))
        }
        onRemove={(value) =>
          guardRemoval("el producto", value, usageMaps.productos[value] || 0, () =>
            setConfig((prev) => ({
              ...prev,
              productos: prev.productos.filter((item) => item !== value),
            }))
          )
        }
        usageMap={usageMaps.productos}
      />

      <div style={{ ...cardStyle(), padding: 18 }}>
        <h3 style={{ marginTop: 0 }}>Colores</h3>
        <div style={{ display: "flex", gap: 10, marginBottom: 12, alignItems: "center" }}>
          <input
            type="color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            style={{ width: 54, height: 40 }}
          />
          <button
            onClick={() =>
              setConfig((prev) => ({
                ...prev,
                colores: prev.colores.includes(newColor) ? prev.colores : [...prev.colores, newColor],
              }))
            }
            style={buttonStyle(true)}
          >
            Agregar color
          </button>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {config.colores.map((c) => (
            <span
              key={c}
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
                  background: c,
                  display: "inline-block",
                }}
              />
              {c}
              {(usageMaps.colores[c] || 0) > 0 && (
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
                  En uso: {usageMaps.colores[c]}
                </span>
              )}
              <button
                onClick={() =>
                  guardRemoval("el color", c, usageMaps.colores[c] || 0, () =>
                    setConfig((prev) => ({
                      ...prev,
                      colores: prev.colores.filter((x) => x !== c),
                    }))
                  )
                }
                style={{ border: "none", background: "transparent", color: danger, cursor: "pointer" }}
                title={(usageMaps.colores[c] || 0) > 0 ? "Este color esta en uso en el Gantt." : "Eliminar"}
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
          setConfig((prev) => ({
            ...prev,
            ccts: normalizeStringList([...prev.ccts, value]),
          }))
        }
        onRemove={(value) =>
          guardRemoval("el CCT", value, usageMaps.ccts[value] || 0, () =>
            setConfig((prev) => ({
              ...prev,
              ccts: prev.ccts.filter((item) => item !== value),
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
          setConfig((prev) => ({
            ...prev,
            bbts: normalizeStringList([...prev.bbts, value]),
          }))
        }
        onRemove={(value) =>
          guardRemoval("el BBT", value, usageMaps.bbts[value] || 0, () =>
            setConfig((prev) => ({
              ...prev,
              bbts: prev.bbts.filter((item) => item !== value),
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
          setConfig((prev) => ({
            ...prev,
            lineasEnvasado: normalizeStringList([...prev.lineasEnvasado, value]),
          }))
        }
        onRemove={(value) =>
          guardRemoval("la linea", value, usageMaps.lineasEnvasado[value] || 0, () =>
            setConfig((prev) => ({
              ...prev,
              lineasEnvasado: prev.lineasEnvasado.filter((item) => item !== value),
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

  const sourceCycles = useMemo(
    () =>
      cycles.filter((cycle) => {
        const cycleDate = getCycleDateValue(cycle.weekStart, cycle.dia);
        const matchesFrom = !fechaDesde || cycleDate >= fechaDesde;
        const matchesTo = !fechaHasta || cycleDate <= fechaHasta;
        return matchesFrom && matchesTo;
      }),
    [cycles, fechaDesde, fechaHasta]
  );

  const productOptions = useMemo(
    () =>
      Array.from(new Set(cycles.filter((cycle) => !cycle.aseo && cycle.producto).map((cycle) => cycle.producto))).sort(),
    [cycles]
  );

  const lineOptions = useMemo(
    () => Array.from(new Set(cycles.map((cycle) => cycle.lineaEnvasado).filter(Boolean))).sort(),
    [cycles]
  );

  const cctOptions = useMemo(
    () =>
      Array.from(
        new Set(
          cycles.flatMap((cycle) => [
            cycle.ccts,
            cycle.origenMezclaTipo === "cct" ? cycle.origenMezcla : "",
          ]).filter(Boolean)
        )
      ).sort(),
    [cycles]
  );

  const bbtOptions = useMemo(
    () =>
      Array.from(
        new Set(
          cycles.flatMap((cycle) => [
            cycle.bbts,
            cycle.origenMezclaTipo === "bbt" ? cycle.origenMezcla : "",
          ]).filter(Boolean)
        )
      ).sort(),
    [cycles]
  );

  const filteredCycles = useMemo(
    () =>
      sourceCycles.filter((cycle) => {
        const cycleIssues = getCycleIssues(cycle);
        const matchesProducto = !producto || cycle.producto === producto;
        const matchesLinea = !linea || cycle.lineaEnvasado === linea;
        const matchesCct =
          !cct ||
          cycle.ccts === cct ||
          (cycle.origenMezclaTipo === "cct" && cycle.origenMezcla === cct);
        const matchesBbt =
          !bbt ||
          cycle.bbts === bbt ||
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
  const totalHoras = filteredCycles.reduce((acc, cycle) => acc + (cycle.horaFin - cycle.horaInicio), 0);
  const totalHl = filteredCycles.reduce((acc, cycle) => acc + parseQuantity(cycle.cantidadHl), 0);

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
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <h3 style={{ margin: 0 }}>Analisis y validaciones</h3>
            <div style={{ fontSize: 12, color: textSoft, marginTop: 4 }}>
              Filtra ciclos por fecha real para revisar datos, detectar faltantes y validar consistencia.
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
          Rango actual: {formatDateLabel(fechaDesde)} {"->"} {formatDateLabel(fechaHasta)}
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
              onChange={(e) => setFechaDesde(e.target.value)}
              style={inputStyle}
            />
          </div>

          <div>
            <label style={{ fontSize: 12, color: textSoft }}>Fecha hasta</label>
            <input
              type="date"
              value={fechaHasta}
              onChange={(e) => setFechaHasta(e.target.value)}
              style={inputStyle}
            />
          </div>

          <div>
            <label style={{ fontSize: 12, color: textSoft }}>Producto</label>
            <select value={producto} onChange={(e) => setProducto(e.target.value)} style={inputStyle}>
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
            <select value={linea} onChange={(e) => setLinea(e.target.value)} style={inputStyle}>
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
            <select value={cct} onChange={(e) => setCct(e.target.value)} style={inputStyle}>
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
            <select value={bbt} onChange={(e) => setBbt(e.target.value)} style={inputStyle}>
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
            <input type="checkbox" checked={onlyMezcla} onChange={(e) => setOnlyMezcla(e.target.checked)} />
            Solo mezclas
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={onlyAseo} onChange={(e) => setOnlyAseo(e.target.checked)} />
            Solo aseos
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
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
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  {getCycleDisplayName(cycle)} | {DAYS[cycle.dia]} | {formatHour(cycle.horaInicio)} - {formatHour(cycle.horaFin)}
                </div>
                <div style={{ fontSize: 12, color: textSoft, marginBottom: 8 }}>
                  Fecha: {formatDateLabel(getCycleDateValue(cycle.weekStart, cycle.dia))}
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
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: `1px solid ${border}` }}>
                {["Fecha", "Dia", "Horario", "Producto", "CCT", "BBT", "HL", "Linea", "Mantenimiento", "Mezcla"].map((head) => (
                  <th key={head} style={{ padding: "10px 8px", fontSize: 12, color: textSoft }}>
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowsWithIssues.length === 0 ? (
                <tr>
                  <td colSpan={10} style={{ padding: "14px 8px", color: textSoft }}>
                    No hay ciclos para mostrar con los filtros actuales.
                  </td>
                </tr>
              ) : (
                rowsWithIssues.map(({ cycle, issues }) => (
                  <tr key={cycle.id} style={{ borderBottom: `1px solid #eef3f8` }}>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>
                      {formatDateLabel(getCycleDateValue(cycle.weekStart, cycle.dia))}
                    </td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>{DAYS[cycle.dia]}</td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>
                      {formatHour(cycle.horaInicio)} - {formatHour(cycle.horaFin)}
                    </td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>{getCycleDisplayName(cycle)}</td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>{cycle.ccts || "-"}</td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>{cycle.bbts || "-"}</td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>{cycle.cantidadHl || "-"}</td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>{cycle.lineaEnvasado || "-"}</td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>
                      {[
                        cycle.mantenimientoProgramado ? "Programado" : "",
                        cycle.mantenimientoCorrectivo ? "Correctivo" : "",
                      ]
                        .filter(Boolean)
                        .join(" | ") || "-"}
                    </td>
                    <td style={{ padding: "10px 8px", fontSize: 13 }}>
                      {cycle.mezcla ? `${formatOrigenMezcla(cycle) || "Mezcla"}${cycle.proporcionMezcla ? ` | ${cycle.proporcionMezcla}` : ""}` : "-"}
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
        <li>Haz click en una fila del Gantt para crear un ciclo.</li>
        <li>Doble click en un bloque para editarlo.</li>
        <li>Arrastra un bloque para moverlo.</li>
        <li>Usa los bordes del bloque para cambiar inicio o fin.</li>
        <li>Usa el selector de semana para saltar a una fecha y una hora especifica.</li>
        <li>Al pasar el cursor por un bloque veras CCTs, BBTs, cantidad y linea.</li>
        <li>Puedes cambiar entre semanas y cada semana queda guardada.</li>
        <li>Desde Admin puedes manejar productos, colores, CCTs, BBTs y lineas sin tocar codigo.</li>
        <li>Puedes exportar la semana actual a Excel o PDF.</li>
      </ul>
    </div>
  );
}

export default function App() {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [config, setConfig] = useState<ConfigState>(DEFAULT_CONFIG);
  const [activeWeekStart, setActiveWeekStart] = useState(getStartOfWeek(new Date()));
  const [planView, setPlanView] = useState<PlanViewKey>("week");
  const [selectedDayIndex, setSelectedDayIndex] = useState(getDayIndexFromDate(toDateInputValue(new Date())));
  const [zoom, setZoom] = useState(1);
  const [modal, setModal] = useState<ModalState>(null);
  const [tab, setTab] = useState<TabKey>("plan");
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [resizing, setResizing] = useState<ResizeState | null>(null);
  const [weekPickerOpen, setWeekPickerOpen] = useState(false);
  const [navigatorDate, setNavigatorDate] = useState(toDateInputValue(new Date()));
  const [navigatorHour, setNavigatorHour] = useState(new Date().getHours());
  const [pendingJump, setPendingJump] = useState<JumpTarget | null>(null);
  const [focusedDay, setFocusedDay] = useState<number | null>(null);
  const [storageReady, setStorageReady] = useState(false);

  const nextId = useRef(1);
  const dayScrollRefs = useRef<(HTMLDivElement | null)[]>([]);
  const weekPickerRef = useRef<HTMLDivElement | null>(null);
  const baseHourWidth = HOUR_WIDTH_BASE * zoom;
  const hourWidth =
    planView === "week"
      ? clamp(Number((baseHourWidth * 0.65).toFixed(2)), 12, 36)
      : baseHourWidth;
  const dayPanelWidth = 24 * hourWidth;
  const usageMaps = useMemo(() => buildUsageMaps(cycles), [cycles]);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      setStorageReady(true);
      return;
    }

    try {
      const parsed = JSON.parse(saved) as {
        cycles?: Record<string, unknown>[];
        config?: Partial<ConfigState>;
        activeWeekStart?: string;
      };

      const storedCycles = Array.isArray(parsed.cycles)
        ? parsed.cycles.map((cycle) => hydrateCycle(cycle))
        : [];

      const storedWeekStart =
        typeof parsed.activeWeekStart === "string" ? parsed.activeWeekStart : getStartOfWeek(new Date());

      setCycles(storedCycles);
      setConfig(buildConfigState(parsed.config));
      setActiveWeekStart(storedWeekStart);
      setNavigatorDate(storedWeekStart);

      const maxId = Math.max(0, ...storedCycles.map((c) => c.id));
      nextId.current = maxId + 1;
    } catch {
      setCycles([]);
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (!storageReady) return;

    localStorage.setItem(
      STORAGE_KEY,
        JSON.stringify({
          cycles,
          config,
          activeWeekStart,
        })
      );
  }, [cycles, config, activeWeekStart, storageReady]);

  useEffect(() => {
    if (!storageReady) return;

    setConfig((prev) => {
      const normalized = buildConfigState(prev);
      return JSON.stringify(normalized) === JSON.stringify(prev) ? prev : normalized;
    });
  }, [storageReady]);

  useEffect(() => {
    if (!weekPickerOpen) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (weekPickerRef.current?.contains(event.target as Node)) return;
      setWeekPickerOpen(false);
    };

    window.addEventListener("mousedown", handleMouseDown);
    return () => window.removeEventListener("mousedown", handleMouseDown);
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

  const weekCycles = useMemo(
    () => cycles.filter((c) => c.weekStart === activeWeekStart),
    [cycles, activeWeekStart]
  );

  const createCycle = (dia: number, hora: number) => {
    setModal({
      mode: "create",
      defaultDia: dia,
      defaultHora: hora,
    });
  };

  const saveCycle = (data: CycleDraft, cycleId?: number) => {
    if (typeof cycleId === "number") {
      const updated = cycles.map((c) => (c.id === cycleId ? { ...c, ...data } : c));
      setCycles(normalizeWeekCycles(updated, activeWeekStart));
    } else {
      const updated = [
        ...cycles,
        {
          id: nextId.current++,
          weekStart: activeWeekStart,
          ...data,
        },
      ];
      setCycles(normalizeWeekCycles(updated, activeWeekStart));
    }
    setModal(null);
  };

  const deleteCycle = (cycleId: number) => {
    setCycles((prev) => prev.filter((c) => c.id !== cycleId));
    setModal(null);
  };

  const duplicateCycle = (cycleId: number) => {
    const original = cycles.find((c) => c.id === cycleId);
    if (!original) return;

    const newId = nextId.current++;
    const duplicated: Cycle = {
      ...original,
      id: newId,
    };

    setCycles((prev) => normalizeWeekCycles([...prev, duplicated], duplicated.weekStart));
    setModal({ mode: "edit", cycleId: newId });
  };

  const startDrag = (e: React.MouseEvent, c: Cycle) => {
    e.stopPropagation();
    setDragging({
      id: c.id,
      startX: e.clientX,
      originalInicio: c.horaInicio,
      duration: c.horaFin - c.horaInicio,
    });
  };

  const startResize = (e: React.MouseEvent, c: Cycle, edge: "left" | "right") => {
    e.stopPropagation();
    e.preventDefault();
    setResizing({
      id: c.id,
      edge,
      startX: e.clientX,
      originalInicio: c.horaInicio,
      originalFin: c.horaFin,
    });
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
    const weekStart = getStartOfWeek(parseDateValue(navigatorDate));
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

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (dragging) {
        const delta = Math.round((e.clientX - dragging.startX) / hourWidth);
        const newStart = clamp(dragging.originalInicio + delta, 0, 24 - dragging.duration);

        setCycles((prev) =>
          normalizeWeekCycles(
            prev.map((c) =>
              c.id === dragging.id
                ? { ...c, horaInicio: newStart, horaFin: newStart + dragging.duration }
                : c
            ),
            activeWeekStart
          )
        );
      }

      if (resizing) {
        const delta = Math.round((e.clientX - resizing.startX) / hourWidth);

        setCycles((prev) =>
          normalizeWeekCycles(
            prev.map((c) => {
              if (c.id !== resizing.id) return c;

              if (resizing.edge === "left") {
                const newStart = clamp(resizing.originalInicio + delta, 0, c.horaFin - 1);
                return { ...c, horaInicio: newStart };
              }

              const newEnd = clamp(resizing.originalFin + delta, c.horaInicio + 1, 24);
              return { ...c, horaFin: newEnd };
            }),
            activeWeekStart
          )
        );
      }
    };

    const up = () => {
      setDragging(null);
      setResizing(null);
    };

    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);

    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [dragging, resizing, hourWidth, activeWeekStart]);

  const exportExcel = () => {
    const rows = weekCycles.map((c) => ({
      Semana: formatWeekLabel(c.weekStart),
      Fecha: formatDateLabel(getCycleDateValue(c.weekStart, c.dia)),
      Dia: DAYS[c.dia],
      Inicio: formatHour(c.horaInicio),
      Fin: formatHour(c.horaFin),
      Producto: getCycleDisplayName(c),
      CCTs: c.ccts,
      BBTs: c.bbts,
      "Cantidad (hl)": c.cantidadHl,
      "Linea de envasado": c.lineaEnvasado,
      "Mant. programado": c.mantenimientoProgramado ? "Si" : "No",
      "Mant. correctivo": c.mantenimientoCorrectivo ? "Si" : "No",
      Mezcla: c.mezcla ? "Si" : "No",
      "Origen mezcla": formatOrigenMezcla(c),
      Proporcion: c.proporcionMezcla,
      Aseo: c.aseo ? "Si" : "No",
      Notas: c.notas,
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Plan");
    XLSX.writeFile(wb, `plan_filtracion_${activeWeekStart}.xlsx`);
  };

  const exportPDF = () => {
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text("PLAN DE PRODUCCION DE FILTRACION CERVECERIA DEL ATLANTICO", 14, 16);
    doc.setFontSize(11);
    doc.text(`Semana: ${formatWeekLabel(activeWeekStart)}`, 14, 24);

    autoTable(doc, {
      startY: 30,
      head: [[
        "Dia",
        "Inicio",
        "Fin",
        "Producto",
        "CCTs",
        "BBTs",
        "Cantidad (hl)",
        "Linea",
        "Mant. prog.",
        "Mant. corr.",
        "Mezcla",
        "Origen mezcla",
        "Proporcion",
        "Aseo",
      ]],
      body: weekCycles.map((c) => [
        DAYS[c.dia],
        formatHour(c.horaInicio),
        formatHour(c.horaFin),
        getCycleDisplayName(c),
        c.ccts,
        c.bbts,
        c.cantidadHl,
        c.lineaEnvasado,
        c.mantenimientoProgramado ? "Si" : "No",
        c.mantenimientoCorrectivo ? "Si" : "No",
        c.mezcla ? "Si" : "No",
        formatOrigenMezcla(c),
        c.proporcionMezcla,
        c.aseo ? "Si" : "No",
      ]),
      styles: { fontSize: 8 },
    });

    doc.save(`plan_filtracion_${activeWeekStart}.pdf`);
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

  const planSummaryCycles =
    planView === "day"
      ? weekCycles.filter((cycle) => cycle.dia === selectedDayIndex)
      : weekCycles;

  const visibleDayIndexes =
    planView === "day" ? [selectedDayIndex] : DAYS.map((_, dayIndex) => dayIndex);

  const renderDayPanel = (dayIndex: number) => {
    const dayCycles = weekCycles.filter((cycle) => cycle.dia === dayIndex);

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
          <div style={{ fontSize: 12, fontWeight: 500, marginTop: 2 }}>
            {formatDayReference(activeWeekStart, dayIndex)}
          </div>
          {planView === "week" && (
            <div style={{ fontSize: 11, marginTop: 4, opacity: 0.75 }}>
              Abrir dia
            </div>
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
              {HOURS.map((h) => (
                <div
                  key={h}
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
                  {formatHour(h)}
                </div>
              ))}
            </div>

            <div
              style={{
                position: "relative",
                display: "flex",
                height: 62,
                cursor: "crosshair",
              }}
              onMouseDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const hour = clamp(Math.floor(x / hourWidth), 0, 23);
                createCycle(dayIndex, hour);
              }}
            >
              {HOURS.map((h) => (
                <div
                  key={h}
                  style={{
                    width: hourWidth,
                    minWidth: hourWidth,
                    borderRight: "1px solid #edf2f7",
                    boxSizing: "border-box",
                  }}
                />
              ))}

              {dayCycles.map((c) => {
                const showMeta = c.horaFin - c.horaInicio >= 3;
                const compactMeta = [c.ccts, c.cantidadHl ? `${c.cantidadHl} hl` : "", c.lineaEnvasado]
                  .filter(Boolean)
                  .join(" | ");

                return (
                  <div
                    key={c.id}
                    title={formatCycleTooltip(c)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setModal({ mode: "edit", cycleId: c.id });
                    }}
                    onMouseDown={(e) => startDrag(e, c)}
                    style={{
                      position: "absolute",
                      left: c.horaInicio * hourWidth,
                      width: (c.horaFin - c.horaInicio) * hourWidth,
                      top: 8,
                      height: 46,
                      background: c.color,
                      color: "#fff",
                      fontSize: 12,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 8,
                      cursor: "grab",
                      userSelect: "none",
                      boxShadow: "0 8px 20px rgba(0,0,0,0.12)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    <div
                      onMouseDown={(e) => startResize(e, c, "left")}
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: 10,
                        cursor: "ew-resize",
                      }}
                    />

                    <div
                      style={{
                        padding: "0 12px",
                        textAlign: "center",
                        lineHeight: 1.15,
                        width: "100%",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 700,
                          overflow: "hidden",
                          whiteSpace: "nowrap",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {getCycleDisplayName(c)}
                      </div>
                      {showMeta && compactMeta && (
                        <div
                          style={{
                            fontSize: 10,
                            opacity: 0.95,
                            marginTop: 3,
                            overflow: "hidden",
                            whiteSpace: "nowrap",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {compactMeta}
                        </div>
                      )}
                    </div>

                    <div
                      onMouseDown={(e) => startResize(e, c, "right")}
                      style={{
                        position: "absolute",
                        right: 0,
                        top: 0,
                        bottom: 0,
                        width: 10,
                        cursor: "ew-resize",
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
          <div style={{ fontSize: 13, color: textSoft }}>Plan semanal con guardado local</div>
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
                <span style={{ fontSize: 11, opacity: weekPickerOpen ? 0.85 : 0.65 }}>
                  SEMANA VISIBLE
                </span>
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
                  <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
                    Ir a una fecha y hora
                  </div>
                  <div style={{ fontSize: 12, color: textSoft, lineHeight: 1.5 }}>
                    Selecciona una fecha y la vista abrira su semana correspondiente. La hora sirve
                    para mover el Gantt directamente a ese tramo.
                  </div>

                  <div style={{ marginTop: 14 }}>
                    <label style={{ fontSize: 12, color: textSoft }}>Fecha</label>
                    <input
                      type="date"
                      value={navigatorDate}
                      onChange={(e) => setNavigatorDate(e.target.value)}
                      style={inputStyle}
                    />
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <label style={{ fontSize: 12, color: textSoft }}>Hora</label>
                    <select
                      value={navigatorHour}
                      onChange={(e) => setNavigatorHour(Number(e.target.value))}
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

                  <button onClick={goToDateAndHour} style={{ ...buttonStyle(true), marginTop: 14, width: "100%" }}>
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
                    {DAYS[selectedDayIndex]} | {formatDayReference(activeWeekStart, selectedDayIndex)}
                  </div>
                  <button onClick={goToNextDayView} style={buttonStyle()}>
                    Dia {">"}
                  </button>
                </>
              )}
              <button
                onClick={() => setZoom((z) => clamp(Number((z - 0.1).toFixed(2)), MIN_ZOOM, MAX_ZOOM))}
                style={buttonStyle()}
              >
                -
              </button>
              <div style={{ minWidth: 70, textAlign: "center", fontWeight: 700, paddingTop: 10 }}>
                {Math.round(zoom * 100)}%
              </div>
              <button
                onClick={() => setZoom((z) => clamp(Number((z + 0.1).toFixed(2)), MIN_ZOOM, MAX_ZOOM))}
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
            <span>Click en una fila para crear ciclo</span>
            <span>|</span>
            <span>Doble click en bloque para editar</span>
            <span>|</span>
            <span>Arrastra para mover</span>
            <span>|</span>
            <span>Bordes para redimensionar</span>
            <span>|</span>
            <span>Usa la semana visible para saltar a fecha y hora</span>
            <span>|</span>
            <span>Click en el titulo del dia para abrir la vista diaria</span>
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
