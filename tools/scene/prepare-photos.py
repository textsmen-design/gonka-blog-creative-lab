#!/usr/bin/env python3
"""Готовит веб-версии двух фотографий из исходников в корне проекта (исходники не изменяются):
  avtor.png  → public/previews/author-portrait.jpg   (портрет 3:4: лицо, рука, плечи — боковая панель)
  avtor.png  → public/previews/author-wide.jpg       (кадр целиком 3:2 — развёрнутая запись автора)
  srbia.png  → public/previews/srbija-belgrade.jpg   (закат над Белградом, 1600×900)
Запуск из корня проекта: python3 tools/scene/prepare-photos.py"""
from PIL import Image
import os

def save(img, path, q):
    img.save(path, 'JPEG', quality=q, optimize=True, progressive=True)
    print(path, img.size, os.path.getsize(path) // 1024, 'КБ')

a = Image.open('avtor.png').convert('RGB')                 # 1536×1024
portrait = a.crop((680, 50, 1180, 717)).resize((600, 800), Image.LANCZOS)   # 500×667 → 3:4
save(portrait, 'public/previews/author-portrait.jpg', 88)
save(a, 'public/previews/author-wide.jpg', 86)                # 1536×1024, без изменения размера и кадра

b = Image.open('srbia.png').convert('RGB')                 # 1672×941 (16:9)
save(b.resize((1600, 900), Image.LANCZOS), 'public/previews/srbija-belgrade.jpg', 85)
