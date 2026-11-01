import * as extract from './extract';

/**
 * Photo rules on top of the extraction prompt (docs/09, 2026-11-01 "Scans"). Same reply schema as extract, so
 * `toExtracted` maps both. Bump `version` on any change here or in extract.
 */
export const version = `photo@1+${extract.version}`;

export function system(ctx: { today: string }): string {
  return `${extract.system(ctx)}

This time the source is a photo or screenshot: a poster, flyer, magazine page, programme listing, ticket or
screenshot. Read all visible text first, then:
- Return EVERY event on it. A listing page with 60 concerts gives 60 events. Skip adverts for shops, records,
  podcasts or websites, entries cut off at the image edge, and anything that is not a dated event in Berlin.
- Day-only dates ("Wed 4", "Sat 14", "25 NOV", "03.11."): the next such date on or after the photo date. When a
  weekday is printed, the date must fall on that weekday. A year heading such as "2027" applies to every entry
  below it until the next heading.
- A fair, market or exhibition printed with days and opening hours ("18–19 Sep 26", "Fr 9–19 Uhr, Sa 9–17 Uhr") is
  ONE event with one date per day, start and end from that day's hours.
- Title: the artist or event name only. Presenter lines ("ByteFM präsentiert", "Radio Eins & Musikexpress
  präsentieren") are not part of the title. Tour names go in the description; support acts ("Support: X", names
  after a bullet under the headliner) are performers.
- Venue exactly as printed ("Columbiahalle", "KitKatClub", "Hole⁴⁴"). A listing of concerts at music venues is
  category concert unless an entry says otherwise.
- Prices: "Tickets € 24,-" is 24; "€ 60,– bis 180,–" is 60 to 180; "ausverkauft" or "sold out" goes in that date's
  note.
- Description: one short sentence for magazine texts, empty for plain listings. Quote: the short printed line the
  event came from, at most 100 characters.
- Lower the confidence when the text is blurry, partly hidden or the date had to be inferred.`;
}

export function user(ctx: { takenAt?: string; note?: string }): string {
  return [
    'Source: a photo uploaded by a user',
    ctx.takenAt ? `Photo date: ${ctx.takenAt}` : '',
    ctx.note ? `The user adds: <note>${ctx.note}</note>` : '',
    'Extract the events from the image above.',
  ]
    .filter(Boolean)
    .join('\n');
}
