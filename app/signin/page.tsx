import { Box, Card, CardContent, Typography } from "@mui/material";
import SignInButton from "./SignInButton";

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
          <Typography variant="h5" component="h1">
            opencode-client
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Sign in to continue
          </Typography>
          <SignInButton />
        </CardContent>
      </Card>
    </Box>
  );
}