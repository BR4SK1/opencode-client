import { Avatar, Box, Card, CardContent, Typography } from "@mui/material";
import SmartToy from "@mui/icons-material/SmartToy";
import { demoMode } from "@/auth";
import SignInButton from "./SignInButton";
import { ThemeToggle } from "../components/ThemeToggle";

export default function SignInPage() {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100dvh",
        p: 2,
      }}
    >
      <Box
        sx={{
          position: "fixed",
          // Defensive safe-area offsets: if sign-in is reached via client-side
          // navigation from the chat page (401 handling), that document keeps
          // viewportFit: "cover", and this fixed toggle would otherwise sit in
          // the status-bar / notch zone. No-op wherever an inset resolves
          // to 0; device-dependent.
          top: "calc(12px + env(safe-area-inset-top, 0px))",
          right: "calc(12px + env(safe-area-inset-right, 0px))",
        }}
      >
        <ThemeToggle />
      </Box>
      <Card sx={{ width: "100%", maxWidth: 360 }}>
        <CardContent
          sx={{
            display: "flex",
            flexDirection: "column",
            gap: 1,
            alignItems: "center",
            py: 4,
          }}
        >
          <Avatar sx={{ width: 56, height: 56, bgcolor: "primary.main" }}>
            <SmartToy sx={{ color: "primary.contrastText" }} />
          </Avatar>
          <Typography variant="h5" component="h1">
            opencode-client
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Sign in to continue
          </Typography>
          <SignInButton demo={demoMode} />
        </CardContent>
      </Card>
    </Box>
  );
}
