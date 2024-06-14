import { program, Option, InvalidArgumentError } from "commander";

const expectInt = (value: string) => {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new InvalidArgumentError("Not a number.");
  }
  return parsed;
};

program
  .version("0.1")
  .description("")
  .addOption(
    new Option("--year <number>", "Year to analyze")
      .default(new Date().getFullYear().toString())
      .argParser(expectInt),
  )
  .addOption(
    new Option("--api-key <string>", "API key for Clockify").env(
      "CLOCKIFY_API_KEY",
    ),
  )
  .parse();

export const options = program.opts();
