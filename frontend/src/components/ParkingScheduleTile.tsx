type ParkingScheduleTileProps = {
  number: string;
  startTime: string;
  endTime: string;
  hasCharging: boolean;
  hint?: string;
};

export function ParkingScheduleTile({ number, startTime, endTime, hasCharging, hint }: ParkingScheduleTileProps) {
  return (
    <article className="parking-schedule-tile" aria-label={`Parkplatz ${number} von ${startTime} bis ${endTime}`}>
      <div className="parking-schedule-number" aria-hidden="true">{number}</div>
      <p className={hasCharging ? 'parking-schedule-tag parking-schedule-tag-charging' : 'parking-schedule-tag parking-schedule-tag-standard'}>
        {hasCharging ? <span aria-hidden="true">⚡</span> : null}
        {hasCharging ? 'E-Ladeplatz' : 'Parkplatz'}
      </p>
      <p className="parking-schedule-time">{startTime}–{endTime}</p>
      <p className="parking-schedule-hint">{hint ?? ' '}</p>
    </article>
  );
}
