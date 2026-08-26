---
name: read
description: Читай файл или часть файла эффективно, без лишних токенов. Использую, когда нужен фрагмент файла, а не весь файл.
---

# Read File

Прочитай $ARGUMENTS минимальным числом токенов. Команды ниже — для PowerShell,
основной оболочки этого проекта.

## Правило путей

Всегда используй `-LiteralPath`. В путях Next.js есть сегменты вида
`apps/web/app/meetings/[id]`, и `-Path` трактует `[id]` как wildcard, поэтому
существующий файл «не находится».

```powershell
Get-Content -LiteralPath 'apps/web/app/meetings/[id]/meeting-files-page.tsx' -TotalCount 40
```

Когда передаёшь список файлов дальше по конвейеру, передавай `FullName` именно в
`-LiteralPath`:

```powershell
Get-ChildItem -Recurse -Filter *.ts | ForEach-Object { Get-Content -LiteralPath $_.FullName -TotalCount 5 }
```

## Порядок чтения

1. Сначала размер, чтобы решить, нужен ли фрагмент:

   ```powershell
   (Get-Content -LiteralPath <file> | Measure-Object -Line).Lines
   ```

2. Затем структура — первые строки файла:

   ```powershell
   Get-Content -LiteralPath <file> -TotalCount 50
   ```

3. Нужное место ищи через `rg` с номерами строк, а не чтением целиком:

   ```powershell
   rg -n 'function|class|export|@Injectable' <file>
   ```

4. Читай только найденный диапазон:

   ```powershell
   Get-Content -LiteralPath <file> | Select-Object -Skip 119 -First 40
   ```

   Это строки 120–159. `-Skip N` пропускает первые N строк.

5. Для JSON бери одно поле, а не весь документ:

   ```powershell
   (Get-Content -LiteralPath <file> -Raw | ConvertFrom-Json).нужное_поле
   ```

6. Для Prisma-схемы бери одну модель:

   ```powershell
   rg -n --multiline 'model <Name> \{[\s\S]*?\n\}' apps/api/prisma/schema.prisma
   ```

## Запреты

- Не читай файл целиком, если нужна одна функция, модель или поле.
- Не дампи логи, `package-lock.json`, сгенерированные файлы и большие JSON.
- Не полагайся на `head`, `sed`, `cat`, `jq`: в этой среде оболочка — PowerShell.
  Если тебе действительно доступен POSIX-shell, эквиваленты — `head -n`,
  `sed -n 'N,Mp'`, `jq`, но `rg` предпочтителен в обеих оболочках.
