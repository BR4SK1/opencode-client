import Container from "@mui/material/Container";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

export default function Home() {
  return (
    <Container maxWidth="sm">
      <Box
        sx={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
          textAlign: "center",
        }}
      >
        <Typography variant="h3" component="h1">
          opencode-client
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Next.js · React · TypeScript · Material UI
        </Typography>
      </Box>
    </Container>
  );
}