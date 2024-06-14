# Clockify Overtime Calculator

This is a simple script that calculates the overtime hours worked in a week using the Clockify API.
It also prints out the total overtime hours worked in the current year.

It's important that your time entries include any sick days and vacation days you've taken, as the script calculates the overtime hours based on the total hours "worked" in a week.

## Usage

```
# run once
env CLOCKIFY_API_KEY=YOUR_API_KEY npm run start -- --year 2024

# dev mode
env CLOCKIFY_API_KEY=YOUR_API_KEY npm run dev
```
