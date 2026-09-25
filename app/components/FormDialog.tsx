"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { FormField, FormInfo } from "@opencode/client";
import {
  Alert,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  FormControl,
  FormControlLabel,
  FormHelperText,
  InputLabel,
  Link,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";

type AnswerValue = string | number | boolean | string[];
type Answers = Record<string, AnswerValue>;

function numericBound(
  value: number | "Infinity" | "-Infinity" | "NaN" | undefined,
): number | undefined {
  if (typeof value === "number") return value;
  if (value === "Infinity") return Infinity;
  if (value === "-Infinity") return -Infinity;
  return undefined;
}

interface FormDialogProps {
  form: FormInfo;
  sessionID: string;
  onDone: () => void;
}

function fieldVisible(field: FormField, answers: Answers): boolean {
  if (field.type === "external") return true;
  if (field.hidden) return false;
  return (field.when ?? []).every((condition) => {
    const value = answers[condition.key];
    const matches = Object.is(value, condition.value);
    return condition.op === "eq" ? matches : !matches;
  });
}

function submittedFieldValue(field: FormField, answers: Answers): AnswerValue | undefined {
  if (field.type === "external") return undefined;
  const value = answers[field.key];
  if (
    field.type === "string" &&
    field.options?.length &&
    field.custom &&
    value === "__custom__"
  ) {
    return (answers[`${field.key}Custom`] as string) || "";
  }
  if (field.type === "multiselect" && field.custom && Array.isArray(value)) {
    const selected = value.filter((item) => item !== "__custom__");
    const custom = answers[`${field.key}Custom`];
    if (value.includes("__custom__") && typeof custom === "string" && custom.trim()) {
      selected.push(custom.trim());
    }
    return selected;
  }
  return value;
}

export default function FormDialog({ form, sessionID, onDone }: FormDialogProps) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Answers>(() => {
    const initial: Answers = {};
    for (const field of form.fields) {
      if ("default" in field && field.default !== undefined) {
        initial[field.key] = field.default;
      } else if (field.type === "boolean") {
        initial[field.key] = false;
      } else if (field.type === "multiselect") {
        initial[field.key] = [];
      } else if (field.type === "external") {
        continue;
      } else {
        initial[field.key] = "";
      }
    }
    return initial;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const visibleFields = useMemo(
    () => form.fields.filter((field) => fieldVisible(field, answers)),
    [answers, form.fields],
  );

  const updateAnswer = (key: string, value: AnswerValue) => {
    setAnswers((current) => ({ ...current, [key]: value }));
  };

  const submit = async () => {
    const invalidField = visibleFields.find((field) => {
      if (field.type === "external") return false;
      const submittedValue = submittedFieldValue(field, answers);
      if (
        field.required &&
        (submittedValue === undefined ||
          submittedValue === "" ||
          (Array.isArray(submittedValue) && submittedValue.length === 0))
      ) {
        return true;
      }
      if (field.type === "string" && typeof submittedValue === "string") {
        if (field.minLength !== undefined && submittedValue.length < field.minLength) return true;
        if (field.maxLength !== undefined && submittedValue.length > field.maxLength) return true;
        if (field.pattern && submittedValue) {
          try {
            if (!new RegExp(field.pattern).test(submittedValue)) return true;
          } catch {
            /* the server validates the schema's pattern */
          }
        }
      }
      if (
        (field.type === "number" || field.type === "integer") &&
        typeof submittedValue === "number"
      ) {
        const minimum = numericBound(field.minimum);
        const maximum = numericBound(field.maximum);
        if (
          (minimum !== undefined && submittedValue < minimum) ||
          (maximum !== undefined && submittedValue > maximum) ||
          (field.type === "integer" && !Number.isInteger(submittedValue))
        ) {
          return true;
        }
      }
      if (field.type === "multiselect" && Array.isArray(submittedValue)) {
        if (
          (field.minItems !== undefined && submittedValue.length < field.minItems) ||
          (field.maxItems !== undefined && submittedValue.length > field.maxItems)
        ) {
          return true;
        }
      }
      return false;
    });
    if (invalidField) {
      setError(`Check the required value and allowed range for “${invalidField.title || invalidField.key}”.`);
      return;
    }

    const answer: Answers = {};
    for (const field of visibleFields) {
      const value = submittedFieldValue(field, answers);
      if (
        value !== undefined &&
        value !== "" &&
        (!Array.isArray(value) || value.length > 0)
      ) {
        answer[field.key] = value;
      }
    }

    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(form.id)}/reply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer }),
        },
      );
      if (response.status === 401) {
        router.push("/signin");
        return;
      }
      if (response.status === 204) {
        onDone();
        return;
      }
      setError("Could not submit the answer. Please review it and try again.");
    } catch {
      setError("Could not reach OpenCode. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const renderField = (field: FormField) => {
    const label = field.title || field.key;
    if (field.type === "external") {
      return (
        <Stack key={field.key} spacing={0.5}>
          {field.description && <FormHelperText>{field.description}</FormHelperText>}
          <Link href={field.url} target="_blank" rel="noreferrer">
            {field.title || field.url}
          </Link>
        </Stack>
      );
    }

    if (field.type === "boolean") {
      return (
        <FormControl key={field.key} required={field.required}>
          <FormControlLabel
            control={
              <Checkbox
                checked={Boolean(answers[field.key])}
                onChange={(event) => updateAnswer(field.key, event.target.checked)}
              />
            }
            label={label}
          />
          {field.description && <FormHelperText>{field.description}</FormHelperText>}
        </FormControl>
      );
    }

    if (field.type === "multiselect") {
      const selectedOptions = answers[field.key];
      return (
        <FormControl key={field.key} fullWidth required={field.required}>
          <InputLabel id={`form-${form.id}-${field.key}-label`}>{label}</InputLabel>
          <Select
            multiple
            labelId={`form-${form.id}-${field.key}-label`}
            label={label}
            value={Array.isArray(answers[field.key]) ? answers[field.key] : []}
            onChange={(event) =>
              updateAnswer(
                field.key,
                typeof event.target.value === "string"
                  ? event.target.value.split(",")
                  : event.target.value,
              )
            }
          >
            {field.options.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
            {field.custom && <MenuItem value="__custom__">Other…</MenuItem>}
          </Select>
          {(field.description || field.required) && (
            <FormHelperText>
              {field.description || (field.required ? "Required" : "")}
            </FormHelperText>
          )}
          {field.custom &&
            Array.isArray(selectedOptions) &&
            selectedOptions.includes("__custom__") && (
              <TextField
                fullWidth
                label={`${label} (custom)`}
                value={typeof answers[`${field.key}Custom`] === "string" ? answers[`${field.key}Custom`] : ""}
                onChange={(event) => updateAnswer(`${field.key}Custom`, event.target.value)}
              />
            )}
        </FormControl>
      );
    }

    if (field.type === "string" && field.options?.length) {
      return (
        <Stack key={field.key} spacing={1}>
          <TextField
            select
            fullWidth
            required={field.required}
            label={label}
            value={typeof answers[field.key] === "string" ? answers[field.key] : ""}
            onChange={(event) => updateAnswer(field.key, event.target.value)}
            helperText={field.description}
          >
            {field.options.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
            {field.custom && <MenuItem value="__custom__">Other…</MenuItem>}
          </TextField>
          {field.custom && answers[field.key] === "__custom__" && (
            <TextField
              fullWidth
              label={`${label} (custom)`}
              value={typeof answers[`${field.key}Custom`] === "string" ? answers[`${field.key}Custom`] : ""}
              onChange={(event) => updateAnswer(`${field.key}Custom`, event.target.value)}
            />
          )}
        </Stack>
      );
    }

    return (
      <TextField
        key={field.key}
        fullWidth
        required={field.required}
        type={
          field.type === "number" || field.type === "integer"
            ? "number"
            : field.format === "date"
              ? "date"
              : field.format === "date-time"
                ? "datetime-local"
                : field.format === "email"
                  ? "email"
                  : field.format === "uri"
                    ? "url"
                    : "text"
        }
        label={label}
        placeholder={field.type === "string" ? field.placeholder : undefined}
        value={answers[field.key] ?? ""}
        onChange={(event) => {
          const value = event.target.value;
          updateAnswer(
            field.key,
            field.type === "number" || field.type === "integer"
              ? value === ""
                ? ""
                : Number(value)
              : value,
          );
        }}
        helperText={field.description}
        slotProps={{
          htmlInput: {
            ...(field.type === "number" || field.type === "integer"
              ? {
                  min: numericBound(field.minimum),
                  max: numericBound(field.maximum),
                  step: field.type === "integer" ? 1 : "any",
                }
              : {}),
            ...(field.type === "string"
              ? {
                  minLength: field.minLength,
                  maxLength: field.maxLength,
                  pattern: field.pattern,
                }
              : {}),
          },
        }}
      />
    );
  };

  return (
    <Dialog
      open
      onClose={() => undefined}
      aria-labelledby="opencode-form-title"
      sx={{ alignItems: { xs: "flex-end", sm: "center" } }}
      slotProps={{
        paper: {
          sx: {
            width: "100%",
            maxWidth: 520,
            maxHeight: "min(85dvh, 760px)",
            borderTopLeftRadius: { xs: 16, sm: 4 },
            borderTopRightRadius: { xs: 16, sm: 4 },
            borderBottomLeftRadius: { xs: 0, sm: 4 },
            borderBottomRightRadius: { xs: 0, sm: 4 },
            m: 0,
          },
        },
      }}
    >
      <Stack spacing={2} sx={{ p: 2.5, overflowY: "auto" }}>
        <Typography variant="h6" id="opencode-form-title">
          {form.title}
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {visibleFields.map(renderField)}
        <Button
          variant="contained"
          disabled={submitting}
          onClick={() => void submit()}
          sx={{ minHeight: 48 }}
        >
          {submitting && <CircularProgress size={20} sx={{ mr: 1 }} />}
          Submit answer
        </Button>
      </Stack>
    </Dialog>
  );
}
