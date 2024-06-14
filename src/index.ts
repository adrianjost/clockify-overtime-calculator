#!/usr/bin/env -S node --import=tsx

import { options } from "./cli";
import { fetchActiveUser, fetchYear } from "./clockify";
import { visualize } from "./ui";

const main = async () => {
  const year = options.year;
  const user = await fetchActiveUser();
  const dataOfYear = await fetchYear(user.defaultWorkspace, user.id, year);
  visualize(year, dataOfYear);
};

main();
