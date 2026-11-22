# Place each actual before/after capture beside the supplied approved mock.
from PIL import Image, ImageDraw
from pathlib import Path

root = Path(__file__).resolve().parent.parent
mock = Image.open(root / 'approved-mock.png').convert('RGB')
for device in ['phone', 'web']:
    for theme in ['bone', 'obsidian']:
        for scene in ['menu', 'one', 'six']:
            crop = {
                'one': (24, 167, 324, 745),
                'six': (688, 167, 988, 745) if theme == 'obsidian' else (356, 167, 656, 745),
                'menu': (1020, 167, 1320, 745),
            }[scene]
            images = [Image.open(root / state / f'{device}-{theme}-{scene}.png').convert('RGB')
                      for state in ['before', 'after']] + [mock.crop(crop)]
            widths = [390, 390, 300] if device == 'phone' else [640, 640, 300]
            scaled = [im.resize((width, round(im.height * width / im.width)))
                      for im, width in zip(images, widths)]
            canvas = Image.new('RGB', (sum(widths) + 64, max(im.height for im in scaled) + 64), '#d0c7b4')
            draw = ImageDraw.Draw(canvas)
            x = 16
            for label, im in zip(['Before (production components)', 'After (production components)', 'Approved mock rev 3'], scaled):
                draw.text((x, 12), label, fill='black')
                canvas.paste(im, (x, 40))
                x += im.width + 16
            canvas.save(root / f'comparison-{device}-{theme}-{scene}.png')
