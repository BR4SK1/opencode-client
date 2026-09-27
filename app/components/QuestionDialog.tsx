"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  Divider,
  FormControlLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { PendingQuestion } from "./ChatApp";

interface QuestionDialogProps {
  request: PendingQuestion;
  onDone: () => void;
}

export default function QuestionDialog({ request, onDone }: QuestionDialogProps) {
  const router = useRouter();
  const [answers, setAnswers] = useState<string[][]>(() =>
    request.questions.map(() => []),
  );
  const [customAnswers, setCustomAnswers] = useState<string[]>(() =>
    request.questions.map(() => ""),
  );
  const [busy, setBusy] = useState<"reply" | "reject" | null>(null);
  const [error, setError] = useState("");

  const updateAnswer = (index: number, values: string[]) => {
    setAnswers((previous) => previous.map((answer, i) => i === index ? values : answer));
  };

  const submit = async (action: "reply" | "reject") => {
    const submittedAnswers = request.questions.map((question, index) => {
      const custom = customAnswers[index]?.trim();
      const selected = answers[index] ?? [];
      if (!custom) return selected;
      return question.multiple ? [...selected, custom] : [custom];
    });

    if (action === "reply" && submittedAnswers.some((answer) => answer.length === 0)) {
      setError("Answer each question before submitting.");
      return;
    }

    setBusy(action);
    setError("");
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(request.sessionID)}/question/${encodeURIComponent(request.id)}/${action}`,
        {
          method: "POST",
          ...(action === "reply"
            ? {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ answers: submittedAnswers }),
              }
            : {}),
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
      const payload = (await response.json().catch(() => ({}))) as { error?: unknown };
      setError(typeof payload.error === "string" ? payload.error : "Could not submit your response. Try again.");
    } catch {
      setError("Could not reach OpenCode. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      onClose={() => undefined}
      aria-labelledby="opencode-question-title"
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
        <Typography variant="h6" id="opencode-question-title">
          OpenCode has a question
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {request.questions.map((question, index) => (
          <Stack key={`${index}-${question.header}`} spacing={1.25}>
            {index > 0 && <Divider />}
            <Stack spacing={0.5}>
              <Typography variant="overline" color="text.secondary">
                {question.header}
              </Typography>
              <Typography variant="body1" sx={{ fontWeight: 600, whiteSpace: "pre-wrap" }}>
                {question.question}
              </Typography>
            </Stack>
            {question.multiple ? (
              <Stack>
                {question.options.map((option) => (
                  <FormControlLabel
                    key={option.label}
                    control={
                      <Checkbox
                        checked={(answers[index] ?? []).includes(option.label)}
                        onChange={(event) => {
                          const selected = answers[index] ?? [];
                          updateAnswer(
                            index,
                            event.target.checked
                              ? [...selected, option.label]
                              : selected.filter((item) => item !== option.label),
                          );
                        }}
                      />
                    }
                    label={
                      <Stack spacing={0.25}>
                        <Typography variant="body2">{option.label}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {option.description}
                        </Typography>
                      </Stack>
                    }
                    sx={{ alignItems: "flex-start", ml: 0, mr: 0, py: 0.5 }}
                  />
                ))}
              </Stack>
            ) : (
              <RadioGroup
                value={answers[index]?.[0] ?? ""}
                onChange={(event) => updateAnswer(index, [event.target.value])}
              >
                {question.options.map((option) => (
                  <FormControlLabel
                    key={option.label}
                    value={option.label}
                    control={<Radio />}
                    label={
                      <Stack spacing={0.25}>
                        <Typography variant="body2">{option.label}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {option.description}
                        </Typography>
                      </Stack>
                    }
                    sx={{ alignItems: "flex-start", ml: 0, mr: 0, py: 0.5 }}
                  />
                ))}
              </RadioGroup>
            )}
            {question.custom && (
              <TextField
                fullWidth
                label="Other answer"
                value={customAnswers[index] ?? ""}
                onChange={(event) =>
                  setCustomAnswers((previous) =>
                    previous.map((answer, i) => i === index ? event.target.value : answer),
                  )
                }
              />
            )}
          </Stack>
        ))}
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <Button
            variant="contained"
            disabled={busy !== null}
            onClick={() => void submit("reply")}
            sx={{ minHeight: 48, flex: 1 }}
          >
            {busy === "reply" && <CircularProgress size={20} sx={{ mr: 1 }} />}
            Submit answers
          </Button>
          <Button
            color="inherit"
            variant="outlined"
            disabled={busy !== null}
            onClick={() => void submit("reject")}
            sx={{ minHeight: 48 }}
          >
            {busy === "reject" && <CircularProgress size={20} sx={{ mr: 1 }} />}
            Dismiss
          </Button>
        </Stack>
      </Stack>
    </Dialog>
  );
}
