import json, math, collections
from pathlib import Path
base=Path(__file__).resolve().parent
captures=json.loads((base/'browser-profile.json').read_text())
queries=json.loads((base/'transaction-boundaries.json').read_text())
groups=collections.defaultdict(list)
for q in queries:
    if q['type']=='sql': groups[q['traceId']].append(q)
metrics=collections.defaultdict(list); samples=[]; used=set(); selected=[]
for c in captures:
    assert len(c['samples'])==20 and not c.get('reason')
    for i,(timing,profile) in enumerate(zip(c['longPressTimings'],c['profiles'])):
        start=profile['timeOrigin']+timing['recognitionStartMs']
        end=profile['timeOrigin']+timing['completionMs']
        create=next(o for o in profile['operations'] if o['operation']=='createHumanCorner' and 'replyEpochMs' in o)
        reads=[o for o in profile['operations'] if o['operation']=='readRoom' and o['sentEpochMs']>=create['sentEpochMs'] and 'replyEpochMs' in o]
        read=reads[0]
        matches=[(trace,qs) for trace,qs in groups.items() if qs[0]['operation']=='phone.createHumanCorner' and create['sentEpochMs']-10<=min(q['startMs'] for q in qs)<=create['replyEpochMs']]
        trace,qs=min(matches,key=lambda pair:abs(min(q['startMs'] for q in pair[1])-create['sentEpochMs']))
        assert trace not in used
        used.add(trace); selected.extend(qs)
        begin=[q for q in qs if q.get('boundary')=='BEGIN'];commit=[q for q in qs if q.get('boundary')=='COMMIT']
        assert len(begin)==len(commit)==1
        r={'recognitionToRequestMs':create['sentEpochMs']-start,
           'createRoundTripMs':create['replyEpochMs']-create['sentEpochMs'],
           'transactionBeginToCommitMs':commit[0]['endMs']-begin[0]['startMs'],
           'createReplyToRoomReadMs':read['sentEpochMs']-create['replyEpochMs'],
           'firstRoomReadRoundTripMs':read['replyEpochMs']-read['sentEpochMs'],
           'firstRoomReplyToRenderedMs':end-read['replyEpochMs'],
           'recognitionToRenderedMs':timing['postRecognitionMs'],
           'minusRequested63point9FloorMs':timing['postRecognitionMs']-63.9,
           'readRoomCalls':len(reads)}
        for key,value in r.items(): metrics[key].append(value)
        samples.append({'capture':c['capture'],'sample':i+1,**r})
assert len(samples)==40
pct=lambda xs,p:sorted(xs)[math.ceil(len(xs)*p)-1]
summary={key:{'p50':pct(values,.5),'p95':pct(values,.95)} for key,values in metrics.items()}
print(json.dumps({'samples':samples,'summary':summary},indent=2))
