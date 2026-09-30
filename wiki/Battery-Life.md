# Battery life

Every device reports its battery on its requests (`X-Battery`), and the server learns from those readings how many days each one has left. No firmware support is needed beyond that header, so remotes and viewports both get it.

## Where it shows

- **Home:** each device's battery bar has a "~N days" hint. Hover it for how fast the battery is falling, how long since the last charge, and how long a full charge lasts. A device that's still learning says "learning…".
- **A remote's page:** the battery badge reads, for example, "72% · ~33 days".
- **Needs attention:** Home warns when a device has about 3 days or less left, and the low (20%) and critical (10%) battery warnings say how many days are left.

## How it's worked out

- **History.** Readings are kept at most once every 30 minutes, or whenever the level changes, for 45 days, in `<DATA_DIR>/battery-history.json` (written at most every 5 minutes, and on shutdown).
- **Charges.** The level jumping up by 3% or more is a charge, and starts a new discharge from the top of the jump.
- **Measured rate.** Once there are 12 hours of readings since the last charge and the level has fallen at least 2%, the drain rate is the least-squares slope of those readings, in % per day. A fuel gauge moves in whole percents, so less than that is noise.
- **Learned rate.** Each discharge of at least 2 days and a 5% drop is folded into a rate learned across charges. Right after a charge, before there's enough new data, that learned rate answers. The more charges a device has been through, the better it knows itself.
- **Days left** = (level − 5%) ÷ rate, counting down from the device's last reading. 5% is about where a remote parks on its charge screen.

A device that barely drains shows no estimate rather than a wildly long one. Removing a device from **Remotes** also deletes its history.
