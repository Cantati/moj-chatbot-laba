export function getToolOutputErrorMessage(toolName: string) {
  return toolName === "generateImage"
    ? "Nie udało się wygenerować obrazu. Spróbuj ponownie."
    : "Nie udało się wykonać narzędzia. Spróbuj ponownie.";
}
