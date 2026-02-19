import { ParkingScheduleTile } from './ParkingScheduleTile';
import { ParkingTransitionIndicator } from './ParkingTransitionIndicator';

type ParkingScheduleEntry = {
  id: string;
  number: string;
  startTime: string;
  endTime: string;
  hasCharging: boolean;
  hint?: string;
  transitionLabel?: string;
};

type ParkingScheduleGridProps = {
  entries: ParkingScheduleEntry[];
};

export function ParkingScheduleGrid({ entries }: ParkingScheduleGridProps) {
  return (
    <div className="parking-schedule-grid" aria-label="Parkplatz-Zeitplan">
      {entries.map((entry) => (
        <div key={entry.id} className="parking-schedule-item">
          <ParkingScheduleTile
            number={entry.number}
            startTime={entry.startTime}
            endTime={entry.endTime}
            hasCharging={entry.hasCharging}
            hint={entry.hint}
          />
          {entry.transitionLabel && <ParkingTransitionIndicator text={entry.transitionLabel} />}
        </div>
      ))}
    </div>
  );
}
