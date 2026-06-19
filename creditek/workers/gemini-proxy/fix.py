content = open('index.js').read()
fixed = content.replace(
    'if (!res.ok) continue;',
    'if (!res.ok) return err("Vertex error " + res.status + ": " + JSON.stringify(data) + " model:" + model.id, 500);'
)
open('index.js', 'w').write(fixed)
print('Reemplazos:', content.count('if (!res.ok) continue;'))
