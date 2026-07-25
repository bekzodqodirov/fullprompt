/**
 * Stage colours as complete class strings.
 *
 * Tailwind compiles the classes it can SEE in the source, so a class built at
 * runtime from a database value (`bg-${color}-100`) would simply not exist in
 * the stylesheet. Hence a fixed map and a fixed palette in the schema.
 */
export const STAGE_CLASS: Record<string, string> = {
  gray: 'bg-gray-100 text-gray-700 border-gray-300',
  blue: 'bg-blue-100 text-blue-800 border-blue-300',
  green: 'bg-green-100 text-green-800 border-green-300',
  amber: 'bg-amber-100 text-amber-800 border-amber-300',
  red: 'bg-red-100 text-red-800 border-red-300',
  purple: 'bg-purple-100 text-purple-800 border-purple-300',
  teal: 'bg-teal-100 text-teal-800 border-teal-300',
};

export const stageClass = (color: string) => STAGE_CLASS[color] ?? STAGE_CLASS.gray!;
