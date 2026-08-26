---
name: read
description: Читай файл или часть файла эффективно, без лишних токенов. Использую, когда нужен фрагмент файла, а не весь файл.
---

# Read File

Прочитай $ARGUMENTS минимальным числом токенов. Команды ниже — для PowerShell.

## Правило путей

Всегда используй `-LiteralPath`. В путях встречаются сегменты в квадратных
скобках, например `app/items/[id]/page.tsx`, и `-Path` трактует `[id]` как
wildcard, поэтому существующий файл «не находится».

```powershell
Get-Content -LiteralPath 'app/items/[id]/page.tsx' -TotalCount 40
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

3. Нужное место ищи инструментом Grep с `output_mode: "content"` и номерами
   строк, а не чтением файла целиком. Шелловый `rg` не используй: в
   изолированной сессии его нет, и упавшая команда стоит шага и текста ошибки.

4. Читай только найденный диапазон:

   ```powershell
   Get-Content -LiteralPath <file> | Select-Object -Skip 119 -First 40
   ```

   Это строки 120–159. `-Skip N` пропускает первые N строк.

5. Для JSON бери одно поле, а не весь документ:

   ```powershell
   (Get-Content -LiteralPath <file> -Raw | ConvertFrom-Json).нужное_поле
   ```

## Запреты

- Не читай файл целиком, если нужна одна функция, модель или поле.
- Не дампи логи, файлы блокировок зависимостей, сгенерированные файлы и большие
  JSON.
- Не полагайся на `head`, `sed`, `cat`, `jq`, если оболочка — PowerShell.
  В POSIX-шелле эквиваленты — `head -n`, `sed -n 'N,Mp'`, `jq`, но поиск в обеих
  оболочках делается инструментом Grep.
