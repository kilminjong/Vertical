# 버티컬 배드민턴 매칭 시스템
## 노... 무 ... 좋다

## 📁 파일
```
index.html / styles.css / app.js → 같은 폴더에 넣고 index.html 더블클릭
```

---

## 📊 구글 시트 구조

### 참가자 탭 (이미 완료 ✅)
| A열 | B열 | C열 | D열 | E열 |
|-----|-----|-----|-----|-----|
| 이름 | 성별 | 급수 | 참석일자 | 참석수 |

### 게임매칭 탭 (자동 저장됨)
| 날짜 | 게임번호 | 유형 | 코트 | Team A | A급수 | Team B | B급수 | 소요시간 | 시각 |

---

## ⚙️ Apps Script 설정 (따라하기)

### 1단계: Apps Script 열기
구글 시트 상단 → **확장 프로그램** → **Apps Script** 클릭

### 2단계: 코드 붙여넣기
기존 코드 **전부 지우고** 아래 코드를 **통째로** 복사-붙여넣기:

```javascript
function doPost(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = JSON.parse(e.postData.contents);

  // ① 게임 기록 → 게임매칭 탭
  if (data.action === 'saveGameLog') {
    var tabName = data.sheetTab || '게임매칭';
    var tab = ss.getSheetByName(tabName);
    if (!tab) {
      tab = ss.insertSheet(tabName);
      tab.appendRow(['날짜','게임번호','유형','코트','Team A','A급수','Team B','B급수','소요시간','시각']);
    }
    for (var i = 0; i < data.games.length; i++) {
      var g = data.games[i];
      tab.appendRow([data.date, g.gameNum, g.type, g.court, g.teamA, g.teamA_levels, g.teamB, g.teamB_levels, g.duration, g.time]);
    }
  }

  // ② 출석 → 참가자 탭 (D열: 참석일자, E열: 참석수)
  if (data.action === 'updateAttendance') {
    var tab = ss.getSheetByName('참가자');
    if (!tab) return ContentService.createTextOutput('no tab');
    var lastRow = tab.getLastRow();
    if (lastRow < 2) return ContentService.createTextOutput('no data');
    var names = tab.getRange(2, 1, lastRow - 1, 1).getValues();

    for (var j = 0; j < data.players.length; j++) {
      var p = data.players[j];
      for (var r = 0; r < names.length; r++) {
        if (names[r][0] === p.name) {
          var row = r + 2;
          // D열: 참석일자 추가
          var cellD = tab.getRange(row, 4);
          var existing = cellD.getValue();
          var newVal = existing ? existing + ', ' + data.date : data.date;
          cellD.setValue(newVal);
          // E열: 참석수 +1
          var cellE = tab.getRange(row, 5);
          var count = Number(cellE.getValue()) || 0;
          cellE.setValue(count + 1);
          break;
        }
      }
    }
  }

  // ③ 기존 출석 저장 (출석기록 탭)
  if (data.action === 'saveAttendance') {
    var tab = ss.getSheetByName('출석기록');
    if (!tab) {
      tab = ss.insertSheet('출석기록');
      tab.appendRow(['날짜','이름','급수','성별','게임수']);
    }
    for (var k = 0; k < data.players.length; k++) {
      var p = data.players[k];
      tab.appendRow([data.date, p.name, p.level, p.gender, p.gameCount]);
    }
  }

  return ContentService.createTextOutput(JSON.stringify({success:true})).setMimeType(ContentService.MimeType.JSON);
}
```

### 3단계: 저장
Ctrl+S (또는 💾 아이콘)

### 4단계: 배포
1. 우측 상단 **배포** → **새 배포** 클릭
2. ⚙️ 유형 선택 → **웹 앱**
3. 설명: 아무거나 (예: "배드민턴")
4. 실행 사용자: **나**
5. 액세스 권한: **모든 사용자**
6. **배포** 클릭
7. **승인** → 구글 계정 선택 → "고급" → "안전하지 않은 페이지로 이동" → **허용**
8. 나오는 URL 복사

### 5단계: URL 붙여넣기
`app.js` 파일을 메모장이나 VS Code로 열고 **16번째 줄** 쯤에 있는:
```
APPS_SCRIPT_URL: '',
```
를 복사한 URL로 변경:
```
APPS_SCRIPT_URL: 'https://script.google.com/macros/s/여기에_긴_URL/exec',
```
저장 후 새로고침하면 끝!

---

## 🎮 사용 흐름

```
시트 불러오기 → 참석 인원 선택 → 게임 매칭 → 코트 배정
    → 게임 진행 → 게임 종료 → 반복...
    → 운동 끝나면:
       📋 게임 기록 → 📤 시트에 내보내기 (게임매칭 탭 저장)
       📋 게임 기록 → 📤 출석 내보내기 (참가자 탭 D·E열 업데이트)
```
