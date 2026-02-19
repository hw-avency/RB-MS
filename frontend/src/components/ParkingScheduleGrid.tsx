import { ParkingScheduleTile } from './ParkingScheduleTile';

type ParkingScheduleEntry = {
  id: string;
  number: string;
  startTime: string;
  endTime: string;
  hasCharging: boolean;
  hint?: string;
  warning?: string;
};

type ParkingScheduleGridProps = {
  entries: ParkingScheduleEntry[];
};

export function ParkingScheduleGrid({ entries }: ParkingScheduleGridProps) {
  return (
    <div className="parking-schedule-grid" aria-label="Parkplatz-Zeitplan">
      {entries.map((entry) => (
        <ParkingScheduleTile
          key={entry.id}
          number={entry.number}
          startTime={entry.startTime}
          endTime={entry.endTime}
          hasCharging={entry.hasCharging}
          hint={entry.hint}
          warning={entry.warning}
        />
      ))}
    </div>
  );
}
