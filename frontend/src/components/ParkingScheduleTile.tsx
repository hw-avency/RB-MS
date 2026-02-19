type ParkingScheduleTileProps = {
  number: string;
  startTime: string;
  endTime: string;
  hasCharging: boolean;
  hint?: string;
  warning?: string;
};

export function ParkingScheduleTile({ number, startTime, endTime, hasCharging, hint, warning }: ParkingScheduleTileProps) {
  return (
    <article className="parking-schedule-tile" aria-label={`Parkplatz ${number} von ${startTime} bis ${endTime}`}>
      {warning && <p className="parking-schedule-warning-badge">{warning}</p>}
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
