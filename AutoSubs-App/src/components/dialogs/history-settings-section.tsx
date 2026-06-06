import * as React from "react";
import { FolderOpen, History, Hash, Clock, Trash2, RotateCcw } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { useSettings } from "@/contexts/SettingsContext";
import {
  getDefaultSubtitleDocumentsDir,
  moveTranscriptsTo,
  pruneTranscripts,
} from "@/utils/file-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Field, FieldGroup } from "@/components/ui/field";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** Broadcast that the stored transcript set changed so listeners (App) reload. */
export const TRANSCRIPTS_CHANGED_EVENT = "autosubs:transcripts-changed";
function notifyTranscriptsChanged(): void {
  window.dispatchEvent(new CustomEvent(TRANSCRIPTS_CHANGED_EVENT));
}

type AgeUnit = "minutes" | "hours" | "days";

const UNIT_FACTORS: Record<AgeUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
};

// Sensible opt-in defaults when a user switches a limit on for the first time.
const DEFAULT_MAX_COUNT = 50;
const DEFAULT_MAX_AGE_MINUTES = 30 * UNIT_FACTORS.days; // 30 days

/** Pick the largest whole unit that represents `minutes` exactly. */
function splitAge(minutes: number): { value: number; unit: AgeUnit } {
  if (minutes > 0 && minutes % UNIT_FACTORS.days === 0) {
    return { value: minutes / UNIT_FACTORS.days, unit: "days" };
  }
  if (minutes > 0 && minutes % UNIT_FACTORS.hours === 0) {
    return { value: minutes / UNIT_FACTORS.hours, unit: "hours" };
  }
  return { value: minutes, unit: "minutes" };
}

export function HistorySettingsSection() {
  const { settings, updateSetting } = useSettings();
  const { t } = useTranslation();

  const [defaultDir, setDefaultDir] = React.useState("");
  const [pendingDir, setPendingDir] = React.useState<string | null>(null);
  const [cleaning, setCleaning] = React.useState(false);
  const [ageUnit, setAgeUnit] = React.useState<AgeUnit>(
    () => splitAge(settings.historyMaxAgeMinutes ?? 0).unit,
  );

  React.useEffect(() => {
    getDefaultSubtitleDocumentsDir()
      .then(setDefaultDir)
      .catch((err) =>
        console.error("[HistorySettings] failed to resolve default dir:", err),
      );
  }, []);

  const currentDir = settings.transcriptStorageDir ?? defaultDir;
  const isCustomDir = settings.transcriptStorageDir != null;

  // --- Storage location -----------------------------------------------------

  const handleChooseFolder = React.useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("settings.history.choosePrompt", "Choose transcripts folder"),
      });
      if (!selected || typeof selected !== "string") return;
      if (selected === currentDir) return;
      setPendingDir(selected);
    } catch (err) {
      console.error("[HistorySettings] folder picker failed:", err);
    }
  }, [currentDir, t]);

  const handleResetToDefault = React.useCallback(() => {
    if (!isCustomDir || !defaultDir) return;
    setPendingDir(defaultDir);
  }, [isCustomDir, defaultDir]);

  const applyLocationChange = React.useCallback(
    async (mode: "move" | "fresh") => {
      const target = pendingDir;
      if (!target) return;
      try {
        if (mode === "move") {
          // Must run before updateSetting so the source is still the old dir.
          const { moved } = await moveTranscriptsTo(target);
          toast.success(
            t("settings.history.moved", {
              count: moved,
              defaultValue: `Moved ${moved} transcript(s)`,
            }),
          );
        }
        // Track the default location as null so it keeps following the default.
        updateSetting(
          "transcriptStorageDir",
          target === defaultDir ? null : target,
        );
        notifyTranscriptsChanged();
      } catch (err) {
        console.error("[HistorySettings] location change failed:", err);
        toast.error(
          t("settings.history.moveFailed", "Failed to move transcripts"),
        );
      } finally {
        setPendingDir(null);
      }
    },
    [pendingDir, defaultDir, updateSetting, t],
  );

  // --- Retention limits -----------------------------------------------------

  const countUnlimited = settings.historyMaxCount == null;
  const ageUnlimited = settings.historyMaxAgeMinutes == null;

  const setCountLimit = (raw: string) => {
    if (raw === "") {
      updateSetting("historyMaxCount", 0);
      return;
    }
    const n = parseInt(raw, 10);
    updateSetting("historyMaxCount", Number.isFinite(n) ? Math.max(0, n) : 0);
  };

  const toggleCountUnlimited = (unlimited: boolean) => {
    updateSetting("historyMaxCount", unlimited ? null : DEFAULT_MAX_COUNT);
  };

  const factor = UNIT_FACTORS[ageUnit];
  const ageValue =
    settings.historyMaxAgeMinutes == null
      ? ""
      : String(
          Math.round((settings.historyMaxAgeMinutes / factor) * 100) / 100,
        );

  const setAgeLimit = (raw: string) => {
    if (raw === "") {
      updateSetting("historyMaxAgeMinutes", 0);
      return;
    }
    const n = parseFloat(raw);
    updateSetting(
      "historyMaxAgeMinutes",
      Number.isFinite(n) ? Math.max(0, Math.round(n * factor)) : 0,
    );
  };

  const toggleAgeUnlimited = (unlimited: boolean) => {
    updateSetting(
      "historyMaxAgeMinutes",
      unlimited ? null : DEFAULT_MAX_AGE_MINUTES,
    );
  };

  // Changing the unit keeps the stored canonical minutes unchanged; only the
  // displayed value scales. Re-derive a tidy unit when toggling between them.
  const changeAgeUnit = (unit: AgeUnit) => setAgeUnit(unit);

  // --- Manual cleanup -------------------------------------------------------

  const handleCleanupNow = React.useCallback(async () => {
    setCleaning(true);
    try {
      const { deleted } = await pruneTranscripts({
        maxCount: settings.historyMaxCount,
        maxAgeMinutes: settings.historyMaxAgeMinutes,
      });
      toast.success(
        t("settings.history.cleaned", {
          count: deleted.length,
          defaultValue: `Removed ${deleted.length} transcript(s)`,
        }),
      );
      notifyTranscriptsChanged();
    } catch (err) {
      console.error("[HistorySettings] cleanup failed:", err);
      toast.error(t("settings.history.cleanFailed", "Cleanup failed"));
    } finally {
      setCleaning(false);
    }
  }, [settings.historyMaxCount, settings.historyMaxAgeMinutes, t]);

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t("settings.sections.history", "History")}
      </h4>

      <FieldGroup className="gap-3">
        {/* Storage location */}
        <Field>
          <Item variant="outline" size="sm">
            <ItemMedia variant="icon" className="bg-purple-100 dark:bg-purple-900/30">
              <FolderOpen className="size-4 text-purple-600 dark:text-purple-400" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {t("settings.history.location.title", "Storage location")}
              </ItemTitle>
              <ItemDescription className="text-xs leading-tight line-clamp-1" title={currentDir}>
                {currentDir || "…"}
              </ItemDescription>
            </ItemContent>
            <ItemActions className="gap-1">
              {isCustomDir && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={handleResetToDefault}
                  title={t("settings.history.location.reset", "Reset to default")}
                >
                  <RotateCcw className="size-4" />
                </Button>
              )}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleChooseFolder}
              >
                {t("settings.history.location.change", "Change…")}
              </Button>
            </ItemActions>
          </Item>
        </Field>

        {/* Max number of transcripts */}
        <Field>
          <Item variant="outline" size="sm">
            <ItemMedia variant="icon" className="bg-sky-100 dark:bg-sky-900/30">
              <Hash className="size-4 text-sky-600 dark:text-sky-400" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {t("settings.history.maxCount.title", "Maximum transcripts")}
              </ItemTitle>
              <ItemDescription className="text-xs leading-tight line-clamp-1">
                {t(
                  "settings.history.maxCount.description",
                  "Keep only the most recent transcripts",
                )}
              </ItemDescription>
            </ItemContent>
            <ItemActions className="items-center gap-2">
              <Input
                type="number"
                min={0}
                inputMode="numeric"
                className="h-9 w-20"
                disabled={countUnlimited}
                value={countUnlimited ? "" : String(settings.historyMaxCount ?? 0)}
                onChange={(e) => setCountLimit(e.target.value)}
              />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Switch
                  checked={countUnlimited}
                  onCheckedChange={toggleCountUnlimited}
                />
                {t("settings.history.unlimited", "Unlimited")}
              </label>
            </ItemActions>
          </Item>
        </Field>

        {/* Max age */}
        <Field>
          <Item variant="outline" size="sm">
            <ItemMedia variant="icon" className="bg-amber-100 dark:bg-amber-900/30">
              <Clock className="size-4 text-amber-600 dark:text-amber-400" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {t("settings.history.maxAge.title", "Maximum age")}
              </ItemTitle>
              <ItemDescription className="text-xs leading-tight line-clamp-1">
                {t(
                  "settings.history.maxAge.description",
                  "Delete transcripts older than this",
                )}
              </ItemDescription>
            </ItemContent>
            <ItemActions className="items-center gap-2">
              <Input
                type="number"
                min={0}
                inputMode="numeric"
                className="h-9 w-16"
                disabled={ageUnlimited}
                value={ageValue}
                onChange={(e) => setAgeLimit(e.target.value)}
              />
              <Select
                value={ageUnit}
                onValueChange={(v) => changeAgeUnit(v as AgeUnit)}
                disabled={ageUnlimited}
              >
                <SelectTrigger className="h-9 w-[104px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">
                    {t("settings.history.units.minutes", "minutes")}
                  </SelectItem>
                  <SelectItem value="hours">
                    {t("settings.history.units.hours", "hours")}
                  </SelectItem>
                  <SelectItem value="days">
                    {t("settings.history.units.days", "days")}
                  </SelectItem>
                </SelectContent>
              </Select>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Switch
                  checked={ageUnlimited}
                  onCheckedChange={toggleAgeUnlimited}
                />
                {t("settings.history.unlimited", "Unlimited")}
              </label>
            </ItemActions>
          </Item>
        </Field>
      </FieldGroup>

      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={cleaning}
        onClick={handleCleanupNow}
      >
        <Trash2 className="size-4" />
        {t("settings.history.cleanupNow", "Clean up now")}
      </Button>

      {/* Move vs start-fresh confirmation when the storage location changes. */}
      <AlertDialog
        open={pendingDir != null}
        onOpenChange={(next) => !next && setPendingDir(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <History className="size-4" />
              {t("settings.history.move.title", "Change storage location")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "settings.history.move.description",
                "Move your existing transcripts to the new folder, or leave them where they are and start fresh?",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
              onClick={() => void applyLocationChange("fresh")}
            >
              {t("settings.history.move.startFresh", "Start fresh")}
            </AlertDialogAction>
            <AlertDialogAction onClick={() => void applyLocationChange("move")}>
              {t("settings.history.move.moveExisting", "Move existing")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
