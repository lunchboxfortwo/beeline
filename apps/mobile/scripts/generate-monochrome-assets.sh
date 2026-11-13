#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Renders the Beeline brand asset set from THE ORIGINAL CONTINUOUS-LINE LOOP
# (canonical geometry, see sources/assets/images/mark.svg — do not redesign).
# In-app brand art keeps its existing palette; launcher icons use Stone.
#
# Requires rsvg-convert (librsvg2-bin) and ImageMagick.

brand_mark="$(node -p "require('./sources/buzz/brand.json').mark")"
ink="$(sed -n "s/^[[:space:]]*bgBase: '\(#[0-9A-Fa-f]\{6\}\)',/\1/p" sources/buzz/groknight.ts | head -1)"
white="#FFFFFF"
image_dir="sources/assets/images"
font_file="sources/assets/fonts/BricolageGrotesque-Bold.ttf"

if [[ -z "$ink" ]] || ! grep -qi "\`$ink\`" ../../DESIGN.md; then
  echo "Unable to prove the Obsidian bgBase token against DESIGN.md." >&2
  exit 1
fi

render_svg() {
  # $1 source svg, $2 size, $3 outfile
  rsvg-convert -w "$2" -h "$2" "$1" >"$3"
}

render_notification_svg() {
  # White loop silhouette on transparent. Android notification / status-bar
  # small icons are a 24×24 dp asset whose optical square is 22×22 dp
  # (Material iconography: 1 dp inset per side, the same 2 px pad on a
  # 48 px xhdpi status-bar template). The loop's documented 146-unit height
  # on the 240-unit canvas is scaled to fill that square on the long axis
  # so it reads beside system icons instead of sitting at natural framing.
  local size="$1" out="$2"
  local scale
  scale="$(node -p '240 / 146 * 22 / 24')"
  {
    echo "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 240 240\" width=\"$size\" height=\"$size\">"
    echo "<g transform=\"translate(124.745 123) scale(${scale}) translate(-124.745 -123)\">"
    grep -o '<path d="[^"]*"' "$image_dir/mark.svg" | head -1 | sed "s|<path d=|<path fill=\"$white\" d=|" | sed 's|$|/>|'
    echo "</g></svg>"
  } | rsvg-convert >"$out"
}

render_lockup() {
  local color="$1"
  local scale="$2"
  local destination="$3"
  local canvas_width=$((180 * scale))
  local canvas_height=$((154 * scale))
  # mark.svg draws the loop on a 240-unit canvas at its natural framing; rasterize
  # at 112*scale so the drawn mark keeps the optical size the layout was designed for.
  local mark_size=$((112 * scale))
  local word_size=$((28 * scale))
  local word_y=$((112 * scale))
  local mark_source="$image_dir/mark.svg"

  if [[ "$color" == "$ink" ]]; then
    mark_source="$image_dir/mark-dark.svg"
  fi

  convert -size "${canvas_width}x${canvas_height}" xc:none \
    \( -background none "$mark_source" -resize "${mark_size}x${mark_size}" \) \
    -gravity north -geometry +0+0 -composite \
    \( -background none -fill "$color" -font "$font_file" -pointsize "$word_size" label:beeline \) \
    -gravity north -geometry "+0+${word_y}" -composite \
    -define png:exclude-chunk=date,time \
    "$destination"
}

# App launcher and browser icons have their own Stone palette and framing.
# Splash artwork stays independent of the launcher identity.
node scripts/generate-app-icons.mjs

# Notification status-bar icon: white silhouette on transparent.
render_notification_svg 512 "$image_dir/icon-notification.png"

# Legacy header logo (tinted at render time).
render_svg "$image_dir/mark-dark.svg" 1024 "$image_dir/logo-black.png"

# Wordmark lockups for light and dark surfaces.
render_lockup "$ink" 1 "$image_dir/logotype-dark.png"
render_lockup "$ink" 2 "$image_dir/logotype-dark@2x.png"
render_lockup "$ink" 3 "$image_dir/logotype-dark@3x.png"
render_lockup "$brand_mark" 1 "$image_dir/logotype-light.png"
render_lockup "$brand_mark" 2 "$image_dir/logotype-light@2x.png"
render_lockup "$brand_mark" 3 "$image_dir/logotype-light@3x.png"

echo "Generated Beeline continuous-line brand assets in ${brand_mark} on ${ink}."
